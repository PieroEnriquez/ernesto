/**
 * `WorkspaceResultCache` — a `ResultCacheStore` that persists entries
 * as JSON files under a per-dispatch `<workdirRoot>/<subdir>/<key>.json`.
 *
 * Why this exists: a dispatch may run inside an allocated workspace
 * (set by `workspaceAllocatorMiddleware`), and certain kinds want their
 * cached outputs to persist across processes / restarts / settle
 * boundaries rather than living only in-memory. The workspace IS the
 * persistence layer for those kinds — entries are git-tracked the
 * moment the workspace is settled, which gives free audit + manual
 * override (a human can edit the JSON or delete it; the next dispatch
 * picks up the change).
 *
 * The store is **content-agnostic**: it encodes whole `CachedEntry`
 * objects as JSON. Callers whose cached values have a domain-specific
 * file format (e.g. markdown with frontmatter) should not use this
 * store — they should read/write those files directly through their
 * own route handlers. This store is for "the engine cached a dispatch
 * output, write it to a workspace file."
 *
 * Lookups when `ctx.workdirRoot` is unset are a clean miss (no error
 * — the caller might be running outside a workspace). Writes when
 * `ctx.workdirRoot` is unset are a no-op for the same reason —
 * persistence falls back gracefully to the in-memory layer above (if
 * any) without crashing the dispatch.
 *
 * Path safety: the resolved file must stay under
 * `<workdirRoot>/<subdir>/` after `path.resolve` normalization. Keys
 * that contain `..`, `/`, `\`, or NUL are rejected at the get/set
 * boundary. Filesystem traversal is structurally impossible.
 */

import { promises as fs } from 'node:fs';
import { dirname, resolve as resolvePath, sep } from 'node:path';

import type { DispatchPreContext } from '../middleware';
import type { CachedEntry, ResultCacheStore } from './result-cache';

export interface WorkspaceResultCacheOpts {
    /** Subdirectory inside the workspace where cache files land.
     *  Default `'_cache/result-cache'`. Choose a path your workspace's
     *  lint catalogue does not flag as user-authored content. */
    subdir?: string;
    /** Clock injection for deterministic tests. Defaults to `Date.now`. */
    now?: () => number;
    /** Per-key file extension. Default `'json'`. The store always
     *  serializes the entry as JSON regardless of extension — this is
     *  cosmetic, useful when a workspace lint rule keys off extensions. */
    extension?: string;
}

/** Forbid path-traversal / absolute-key inputs at the API boundary.
 *  These characters never appear in legitimate keys (which are SHAs
 *  or stable-stringify hashes); rejecting at the boundary keeps the
 *  later `resolve` containment check a defense-in-depth rather than
 *  the only protection. */
const UNSAFE_KEY_CHARS = /[\0/\\]/;

export class WorkspaceResultCache implements ResultCacheStore {
    private readonly subdir: string;
    private readonly extension: string;
    private readonly nowFn: () => number;

    constructor(opts: WorkspaceResultCacheOpts = {}) {
        this.subdir = opts.subdir ?? '_cache/result-cache';
        this.extension = opts.extension ?? 'json';
        this.nowFn = opts.now ?? Date.now;
    }

    async get(
        key: string,
        ctx: DispatchPreContext,
    ): Promise<CachedEntry | undefined> {
        const target = this.resolveTarget(key, ctx);
        if (!target) return undefined;
        let raw: string;
        try {
            raw = await fs.readFile(target, 'utf8');
        } catch (err) {
            if (isNotFound(err)) return undefined;
            throw err;
        }
        let entry: CachedEntry;
        try {
            entry = JSON.parse(raw) as CachedEntry;
        } catch {
            // Corrupt file — treat as a miss so the dispatch
            // regenerates and overwrites cleanly. We don't delete here
            // because two concurrent dispatches could race; the next
            // `set` will replace it atomically anyway.
            return undefined;
        }
        if (
            typeof entry !== 'object' ||
            entry === null ||
            typeof entry.expiresAt !== 'number'
        ) {
            return undefined;
        }
        if (entry.expiresAt < this.nowFn()) return undefined;
        return entry;
    }

    async set(
        key: string,
        value: CachedEntry,
        ctx: DispatchPreContext,
    ): Promise<void> {
        const target = this.resolveTarget(key, ctx);
        if (!target) return;
        await fs.mkdir(dirname(target), { recursive: true });
        // Write atomically: write to a sibling tempfile then rename.
        // Avoids a partial-write being read by a concurrent `get`.
        const temp = `${target}.tmp.${process.pid}.${this.nowFn()}`;
        await fs.writeFile(temp, JSON.stringify(value), 'utf8');
        await fs.rename(temp, target);
    }

    /** Returns the absolute filesystem path for `key` under the
     *  current workspace, or `undefined` when the dispatch wasn't
     *  given a workspace (sets become no-ops, gets become misses).
     *  Throws on path-traversal inputs — these are programmer errors,
     *  not run-time failure modes. */
    private resolveTarget(
        key: string,
        ctx: DispatchPreContext,
    ): string | undefined {
        const workdirRoot = ctx.workdirRoot;
        if (!workdirRoot) return undefined;
        if (key.length === 0 || UNSAFE_KEY_CHARS.test(key) || key.includes('..')) {
            throw new Error(`WorkspaceResultCache: unsafe key "${key}"`);
        }
        const base = resolvePath(workdirRoot, this.subdir);
        const target = resolvePath(base, `${key}.${this.extension}`);
        if (target !== base && !target.startsWith(base + sep)) {
            throw new Error(
                `WorkspaceResultCache: resolved target "${target}" escapes "${base}"`,
            );
        }
        return target;
    }
}

function isNotFound(err: unknown): boolean {
    return (
        typeof err === 'object' &&
        err !== null &&
        (err as { code?: string }).code === 'ENOENT'
    );
}
