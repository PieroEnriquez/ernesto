/**
 * Per-user OVERLAY VIEW — the read side of the content-overlay model.
 *
 * Ernesto's durable per-user mutable state is a CONTENT-OVERLAY patch over the
 * always-current master-FS (PROJECT.md §2/§3.1): `{ baseSha, files: { path →
 * { content } | { deleted } } }`. A read = look in the patch, else the lower
 * layer. Because the patch carries full content per touched path (not a
 * rebase-sensitive unified diff), it overlays cleanly over a MOVING lower
 * layer — master-FS shifts underneath and the view just re-overlays, giving
 * conflict-free reads. The unified diff is the settle/wire representation only
 * (see `workdir/overlay-to-diff.ts`).
 *
 * This module is the pure READ model. It is injected a tiny {@link FsReader}
 * (the lower layer) so it never hardcodes node fs and is unit-testable with
 * in-memory fixtures. It reuses the canonical workspace primitives —
 * `boundaryForName`/`boundaryForPath` and the `parseWorkspaceFrontmatter` +
 * `canRead` access model — so a merged boundary/visibility decision matches
 * exactly what the settle gate would allow. A patch that adds
 * `workspaces/x/WORKSPACE.md` introduces a NEW boundary, first-class; a patch
 * that deletes a `WORKSPACE.md` removes one.
 *
 * Separation of concerns (PROJECT.md §5): the overlay VIEW (read) lives here in
 * `workspaces/`; the overlay SETTLE (mutation) lives in `workdir/`.
 */

import { boundaryForName, boundaryForPath, type WorkspaceBoundary } from './boundaries';
import { RESERVED_SYSTEM_WORKSPACES } from '../lint/lint-workspace';
import { parseWorkspaceFrontmatter, canRead } from './access';
import type { WorkspaceVisibility } from './visibility';

const WORKSPACE_MD = 'WORKSPACE.md';
const ERNESTO_WORKSPACE = '_ernesto';

/** Subtrees never descended into while hunting for boundaries — master-FS
 *  mirrors, generated output, archived content. Mirrors `boundaries.ts`'s
 *  PRUNE_DIRS so the overlay scan and the on-disk scan agree. */
const PRUNE_DIRS = new Set(['extracted', 'attached', '_results', 'archive', 'node_modules', '.git']);

/** One directory entry surfaced by an {@link FsReader}. */
export interface FsReaderDirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
}

/**
 * The lower layer of an overlay, abstracted so the view never hardcodes node
 * fs. All paths are POSIX, tree-relative (e.g. `workspaces/hr/WORKSPACE.md`).
 * A node-backed implementation lives in the backend; in-memory fixtures
 * implement it for tests.
 *
 *   - `readFile`  — file contents as utf8, or reject when absent/unreadable.
 *   - `readdir`   — directory entries, or reject when absent/not a dir.
 *   - `stat`      — file/dir classification, or reject when absent.
 */
export interface FsReader {
    readFile(rel: string): Promise<string>;
    readdir(rel: string): Promise<FsReaderDirent[]>;
    stat(rel: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
}

/**
 * A single overlaid file: full content, or a tombstone hiding the lower layer.
 *
 * `base?` is the PER-FILE merge base: the master-FS git rev this entry's content
 * was authored against (stamped at capture as the master HEAD then). Reconcile
 * 3-ways each file against ITS OWN base, so a file the user edited against the
 * current tree applies cleanly even when an unrelated concurrent settle advanced
 * the global base — no manufactured conflicts. Absent ⇒ fall back to the global
 * {@link WorkspacePatch.baseSha} (legacy entries, pre-per-file-base).
 */
export type PatchEntry = { content: string; base?: string } | { deleted: true; base?: string };

/**
 * The durable per-user content-overlay (PROJECT.md §2). `baseSha` is the GLOBAL
 * fallback base — the master-FS revision the overlay was last fully reconciled
 * against; a file with its own `files[path].base` uses that instead (used by
 * settle's 3-way / reconcile; the read view needs neither). `files` maps
 * tree-relative POSIX paths to full content or a deletion tombstone.
 */
export interface WorkspacePatch {
    baseSha: string;
    files: Record<string, PatchEntry>;
}

function isDeleted(e: PatchEntry): e is { deleted: true } {
    return (e as { deleted?: true }).deleted === true;
}

/** A patch carrying no overlay — the read-only / clean-main principal. */
export function emptyPatch(baseSha = ''): WorkspacePatch {
    return { baseSha, files: {} };
}

export interface ComputeOverlayVisibilityOptions {
    /** Caller-resolved admin bypass (agent-ops / support preview): every
     *  boundary readable. The access model never decides this. */
    isAdmin: boolean;
}

/**
 * A read view of `masterFS ⊕ patch`. Pure and injected — construct with
 * {@link makeOverlayView}. Methods resolve the upper (patch) layer first, then
 * the lower (master-FS) layer, honoring deletion tombstones throughout.
 */
export interface OverlayView {
    /** Patch content if present (reject if the path is a deletion tombstone),
     *  else the lower layer. */
    readFile(rel: string): Promise<string>;
    /** True iff the path resolves to existing content in the merged view (a
     *  deletion tombstone shadows the lower layer → false). */
    exists(rel: string): Promise<boolean>;
    /** Union of lower-layer and patch-added entries under `rel`, minus
     *  deletions. Sorted, de-duplicated. */
    listDir(rel: string): Promise<FsReaderDirent[]>;
    /** Every workspace boundary in the merged view, any depth — patch-added
     *  `WORKSPACE.md`s introduce boundaries, patch-deleted ones remove them. */
    scanBoundaries(): Promise<WorkspaceBoundary[]>;
    /** The principal's merged read view (boundaries + readable leaf names),
     *  deciding each boundary against its merged-view `WORKSPACE.md`. */
    computeVisibility(scopes: ReadonlySet<string>, opts: ComputeOverlayVisibilityOptions): Promise<WorkspaceVisibility>;
}

/** Build an {@link OverlayView} over a lower-layer {@link FsReader} + a patch. */
export function makeOverlayView(lower: FsReader, patch: WorkspacePatch): OverlayView {
    const files = patch.files;

    async function lowerExists(rel: string): Promise<boolean> {
        try {
            await lower.stat(rel);
            return true;
        } catch {
            return false;
        }
    }

    async function readFile(rel: string): Promise<string> {
        const entry = files[rel];
        if (entry !== undefined) {
            if (isDeleted(entry)) {
                throw new Error(`overlay: ${rel} is deleted`);
            }
            return entry.content;
        }
        return lower.readFile(rel);
    }

    async function exists(rel: string): Promise<boolean> {
        const entry = files[rel];
        if (entry !== undefined) return !isDeleted(entry);
        return lowerExists(rel);
    }

    /** Immediate child names the patch ADDS under `dir` (the first segment past
     *  `dir/`), excluding ones whose only patch entry is a deletion. A file the
     *  patch adds also implies its parent dirs exist in the merged view. */
    function patchChildren(dir: string): { files: Set<string>; dirs: Set<string> } {
        const prefix = dir === '' ? '' : `${dir}/`;
        const fileNames = new Set<string>();
        const dirNames = new Set<string>();
        for (const [p, entry] of Object.entries(files)) {
            if (!p.startsWith(prefix)) continue;
            const rest = p.slice(prefix.length);
            if (rest === '') continue;
            const slash = rest.indexOf('/');
            if (slash === -1) {
                // direct child file
                if (!isDeleted(entry)) fileNames.add(rest);
            } else {
                // nested → the first segment is a child directory that exists
                // iff the patch adds (not just deletes) at least one file under it
                if (!isDeleted(entry)) dirNames.add(rest.slice(0, slash));
            }
        }
        return { files: fileNames, dirs: dirNames };
    }

    async function listDir(rel: string): Promise<FsReaderDirent[]> {
        const byName = new Map<string, FsReaderDirent>();

        let lowerEntries: FsReaderDirent[] = [];
        try {
            lowerEntries = await lower.readdir(rel);
        } catch {
            lowerEntries = [];
        }
        for (const e of lowerEntries) byName.set(e.name, e);

        // Drop lower entries the patch has deleted (a file tombstone hides the
        // lower file of the same name).
        const prefix = rel === '' ? '' : `${rel}/`;
        for (const [p, entry] of Object.entries(files)) {
            if (!isDeleted(entry)) continue;
            if (!p.startsWith(prefix)) continue;
            const rest = p.slice(prefix.length);
            if (rest !== '' && rest.indexOf('/') === -1) byName.delete(rest);
        }

        const { files: addedFiles, dirs: addedDirs } = patchChildren(rel);
        for (const name of addedDirs) {
            if (!byName.has(name)) byName.set(name, makeDirent(name, false));
        }
        for (const name of addedFiles) {
            // A patch file shadows a lower dir of the same name only in the
            // pathological case; prefer the file classification it carries.
            byName.set(name, makeDirent(name, true));
        }

        return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    }

    async function scanBoundaries(): Promise<WorkspaceBoundary[]> {
        const out: WorkspaceBoundary[] = [];
        const seen = new Set<string>();

        async function walk(relDir: string): Promise<void> {
            const entries = await listDir(relDir);
            const hasWsMd = await exists(`${relDir}/${WORKSPACE_MD}`);
            if (hasWsMd && !seen.has(relDir)) {
                seen.add(relDir);
                out.push({ name: relDir.split('/').pop()!, dir: relDir });
            }
            for (const e of entries) {
                if (!e.isDirectory() || PRUNE_DIRS.has(e.name)) continue;
                await walk(`${relDir}/${e.name}`);
            }
        }

        const top = await listDir('workspaces');
        for (const e of top) {
            if (e.isDirectory() && !PRUNE_DIRS.has(e.name)) {
                await walk(`workspaces/${e.name}`);
            }
        }
        return out;
    }

    async function computeVisibility(scopes: ReadonlySet<string>, opts: ComputeOverlayVisibilityOptions): Promise<WorkspaceVisibility> {
        const all = await scanBoundaries();
        if (all.length === 0) {
            return { all, readableNames: new Set([ERNESTO_WORKSPACE]) };
        }
        const readableNames = new Set<string>();
        for (const boundary of all) {
            if (RESERVED_SYSTEM_WORKSPACES.has(boundary.name) || opts.isAdmin) {
                readableNames.add(boundary.name);
                continue;
            }
            let body: string;
            try {
                body = await readFile(`${boundary.dir}/${WORKSPACE_MD}`);
            } catch {
                continue; // fail-closed
            }
            if (canRead(parseWorkspaceFrontmatter(body), scopes)) {
                readableNames.add(boundary.name);
            }
        }
        return { all, readableNames };
    }

    return { readFile, exists, listDir, scanBoundaries, computeVisibility };
}

function makeDirent(name: string, isFile: boolean): FsReaderDirent {
    return {
        name,
        isFile: () => isFile,
        isDirectory: () => !isFile,
    };
}

/** Re-exports so consumers locate paths the same way the on-disk model does. */
export { boundaryForName, boundaryForPath };
