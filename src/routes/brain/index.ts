/**
 * `brain://*` — the universal FS primitive for the brain (master-fs).
 *
 * **Naming.** "The brain" is Ernesto's canonical persistent state: the
 * git-backed master-fs that holds workflows, dashboards, managed
 * agents, extractions, attached files — the org's shared cognition.
 * The agent edits a workdir-bound view of it; settle propagates back.
 * Workspaces are subdivisions within the brain (marketing, payments,
 * _ernesto, …). Don't extend the metaphor further: workdir stays
 * workdir, workspaces stay workspaces — names the unnamed, don't
 * rename the named.
 *
 * **The collapse.** Transports historically each had their own FS surface:
 * the in-process transport used SDK built-in `Read`/`Write`/`Edit`/`Glob`/`Grep`;
 * the mcp transport exposed bespoke `fs_*` MCP tools; the laptop transport
 * used Claude Code hooks for sparse materialization. Three tool sets,
 * three implementations. The agent's prompt had to know which transport it was on.
 *
 * This module makes FS a route family — same `brain://*` URIs across
 * every transport. Transport-specific renderers vary at the *dispatch* layer
 * (in-process: in-process; mcp: MCP-over-HTTP; laptop: Claude-Code-hook
 * with local materialization), but the contract, input/output
 * schemas, and path-security rules are shared.
 *
 * **What "renderer" means here.** A transport doesn't reimplement the
 * primitive — it picks the most efficient transport for `execute({uri:
 * 'brain://read', ...})`. The agent never sees the difference.
 *
 * Routes:
 *   - `brain://read   { path }                   → { content }`
 *   - `brain://glob   { pattern }                → { paths }`
 *   - `brain://write  { path, content }          → { ok, path }`
 *   - `brain://edit   { path, oldString, newString } → { ok, path }`
 *   - `brain://grep   { pattern, glob? }         → { matches }`
 *
 * Path-security: every path is workdir-relative, `..` is rejected at
 * the regex level (`containsParentSegment`), and the resolved absolute
 * path must remain within `ctx.workdirRoot` (`isPathWithin`). Routes
 * called outside a workdir-bound context return `invalid_input`.
 */

import { promises as fs } from 'node:fs';
import { dirname, join, posix, sep } from 'node:path';
import { z } from 'zod';
import { containsParentSegment, isPathWithin, resolvePath } from '../../path-security';
import { defineRoute } from '../../route/define-route';
import type { RouteRegistry } from '../../route/route-registry';

// ─── Shared shapes ────────────────────────────────────────────────────────

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MiB — same as Read built-in's
const MAX_GLOB_RESULTS = 5_000;
const MAX_GREP_MATCHES = 1_000;

const workspaceReadInput = z.object({
    path: z.string().min(1).max(1024),
});
const workspaceReadOutput = z.object({
    path: z.string(),
    content: z.string(),
});

const workspaceGlobInput = z.object({
    pattern: z.string().min(1).max(512),
});
const workspaceGlobOutput = z.object({
    paths: z.array(z.string()),
    truncated: z.boolean(),
});

const workspaceWriteInput = z.object({
    path: z.string().min(1).max(1024),
    content: z.string().max(MAX_FILE_BYTES),
});
const workspaceWriteOutput = z.object({
    ok: z.literal(true),
    path: z.string(),
    bytes: z.number(),
});

const workspaceEditInput = z.object({
    path: z.string().min(1).max(1024),
    oldString: z.string().min(1),
    newString: z.string(),
});
const workspaceEditOutput = z.object({
    ok: z.literal(true),
    path: z.string(),
});

const workspaceGrepInput = z.object({
    pattern: z.string().min(1).max(512),
    glob: z.string().min(1).max(512).optional(),
    caseInsensitive: z.boolean().optional(),
});
const workspaceGrepOutput = z.object({
    matches: z.array(
        z.object({
            path: z.string(),
            line: z.number(),
            text: z.string(),
        }),
    ),
    truncated: z.boolean(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────

interface ResolvedPath {
    rel: string;
    abs: string;
}

interface WorkspaceErr {
    ok: false;
    error: 'invalid_input' | 'not_found' | 'too_large' | 'handler_failed';
    details?: unknown;
}

function pathError(code: WorkspaceErr['error'], message: string): WorkspaceErr {
    return { ok: false, error: code, details: { message } };
}

function resolveWorkspacePath(workdirRoot: string | undefined, inputPath: string): ResolvedPath | WorkspaceErr {
    if (!workdirRoot) {
        return pathError('invalid_input', 'brain://* requires a workdir-bound context');
    }
    if (containsParentSegment(inputPath)) {
        return pathError('invalid_input', `path "${inputPath}" contains a parent segment ("..") and is rejected`);
    }
    // Normalise the relative path (strip leading ./ and slashes) so
    // join produces a clean absolute. Posix-style on the input even on
    // Windows; we resolve through the OS-native `join` afterwards.
    const rel = inputPath.replace(/^\.\/+/, '').replace(/^\/+/, '');
    const abs = resolvePath(join(workdirRoot, rel));
    const allowed = resolvePath(workdirRoot);
    if (!isPathWithin(abs, allowed)) {
        return pathError('invalid_input', `path "${inputPath}" resolves outside the workdir and is rejected`);
    }
    return { rel, abs };
}

function isWorkspaceErr(v: ResolvedPath | WorkspaceErr): v is WorkspaceErr {
    return (v as WorkspaceErr).ok === false;
}

// ─── Route registration ──────────────────────────────────────────────────

export function registerBrainRoutes(registry: RouteRegistry): void {
    registry.register(
        defineRoute({
            uri: 'brain://read',
            scope: [],
            description:
                'Read a workdir-relative file. Returns `{ path, content }`. ' +
                'Paths must stay within the workdir; `..` segments are rejected. ' +
                `Files larger than ${MAX_FILE_BYTES} bytes return \`too_large\`.`,
            input: workspaceReadInput,
            output: workspaceReadOutput,
            handler: async (input, ctx) => {
                const resolved = resolveWorkspacePath(ctx.workdirRoot, input.path);
                if (isWorkspaceErr(resolved)) {
                    throw new Error((resolved.details as { message: string }).message);
                }
                let stat;
                try {
                    stat = await fs.stat(resolved.abs);
                } catch (err) {
                    throw new Error(`read "${input.path}" failed: ${(err as Error).message}`);
                }
                if (stat.size > MAX_FILE_BYTES) {
                    throw new Error(`file "${input.path}" is ${stat.size} bytes, over the ${MAX_FILE_BYTES}-byte cap`);
                }
                const content = await fs.readFile(resolved.abs, 'utf8');
                return { path: resolved.rel, content };
            },
        }),
    );

    registry.register(
        defineRoute({
            uri: 'brain://glob',
            scope: [],
            description:
                'Match files under the workdir by glob pattern. Returns paths ' +
                'relative to the workdir, capped at ' +
                `${MAX_GLOB_RESULTS} results (set \`truncated: true\` when hit).`,
            input: workspaceGlobInput,
            output: workspaceGlobOutput,
            handler: async (input, ctx) => {
                if (!ctx.workdirRoot) {
                    throw new Error('brain://* requires a workdir-bound context');
                }
                if (containsParentSegment(input.pattern)) {
                    throw new Error(`pattern "${input.pattern}" contains a parent segment ("..") and is rejected`);
                }
                // Use node's glob via fs.glob (Node 22+) — falls back
                // to manual walk if not available. Workdir-bounded by
                // construction: `cwd` is the workdir.
                const paths: string[] = [];
                let truncated = false;
                // Node's fs.glob exists in 22+; deferring to a simple
                // recursive walk so we don't tie the lib's min-node to
                // 22 just for this. The walk is fine for `workspaces/`-
                // scale trees; large repos would warrant the native.
                const allowed = resolvePath(ctx.workdirRoot);
                async function walk(dir: string): Promise<void> {
                    if (truncated) return;
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    } catch {
                        return;
                    }
                    for (const entry of entries) {
                        if (truncated) return;
                        const abs = join(dir, entry.name);
                        if (!isPathWithin(abs, allowed)) continue;
                        if (entry.isDirectory()) {
                            await walk(abs);
                        } else if (entry.isFile()) {
                            const rel = abs
                                .slice(allowed.length + 1)
                                .split(sep)
                                .join(posix.sep);
                            if (matchesGlob(rel, input.pattern)) {
                                if (paths.length >= MAX_GLOB_RESULTS) {
                                    truncated = true;
                                    return;
                                }
                                paths.push(rel);
                            }
                        }
                    }
                }
                await walk(allowed);
                return { paths, truncated };
            },
        }),
    );

    registry.register(
        defineRoute({
            uri: 'brain://write',
            scope: [],
            description:
                'Atomically write a workdir-relative file. Creates parent ' +
                'directories. Returns `{ ok: true, path, bytes }` on success.',
            input: workspaceWriteInput,
            output: workspaceWriteOutput,
            handler: async (input, ctx) => {
                const resolved = resolveWorkspacePath(ctx.workdirRoot, input.path);
                if (isWorkspaceErr(resolved)) {
                    throw new Error((resolved.details as { message: string }).message);
                }
                await fs.mkdir(dirname(resolved.abs), { recursive: true });
                // Atomic write: tmp file + rename. Avoids partial reads
                // mid-write from concurrent readers on the same workdir
                // (the in-process transport's hardlink-mirror sees the rename atomically).
                const tmp = `${resolved.abs}.tmp-${Date.now()}-${process.pid}`;
                await fs.writeFile(tmp, input.content, 'utf8');
                await fs.rename(tmp, resolved.abs);
                return {
                    ok: true as const,
                    path: resolved.rel,
                    bytes: Buffer.byteLength(input.content, 'utf8'),
                };
            },
        }),
    );

    registry.register(
        defineRoute({
            uri: 'brain://edit',
            scope: [],
            description:
                'Replace exactly one occurrence of `oldString` with `newString` ' +
                'in the named workdir-relative file. Fails if `oldString` ' +
                'appears zero times or more than once.',
            input: workspaceEditInput,
            output: workspaceEditOutput,
            handler: async (input, ctx) => {
                const resolved = resolveWorkspacePath(ctx.workdirRoot, input.path);
                if (isWorkspaceErr(resolved)) {
                    throw new Error((resolved.details as { message: string }).message);
                }
                const original = await fs.readFile(resolved.abs, 'utf8');
                const idx = original.indexOf(input.oldString);
                if (idx < 0) {
                    throw new Error(`edit "${input.path}": oldString not found`);
                }
                if (original.indexOf(input.oldString, idx + 1) >= 0) {
                    throw new Error(
                        `edit "${input.path}": oldString appears multiple times — ` +
                            'pass a longer substring that uniquely identifies the site',
                    );
                }
                const updated = original.slice(0, idx) + input.newString + original.slice(idx + input.oldString.length);
                const tmp = `${resolved.abs}.tmp-${Date.now()}-${process.pid}`;
                await fs.writeFile(tmp, updated, 'utf8');
                await fs.rename(tmp, resolved.abs);
                return { ok: true as const, path: resolved.rel };
            },
        }),
    );

    registry.register(
        defineRoute({
            uri: 'brain://grep',
            scope: [],
            description:
                'Substring search across the workdir. Optional `glob` narrows ' +
                'the file set. Returns up to ' +
                `${MAX_GREP_MATCHES} matches (\`truncated: true\` when hit).`,
            input: workspaceGrepInput,
            output: workspaceGrepOutput,
            handler: async (input, ctx) => {
                if (!ctx.workdirRoot) {
                    throw new Error('brain://* requires a workdir-bound context');
                }
                const allowed = resolvePath(ctx.workdirRoot);
                const needle = input.caseInsensitive ? input.pattern.toLowerCase() : input.pattern;
                const matches: Array<{ path: string; line: number; text: string }> = [];
                let truncated = false;
                async function walk(dir: string): Promise<void> {
                    if (truncated) return;
                    let entries;
                    try {
                        entries = await fs.readdir(dir, { withFileTypes: true });
                    } catch {
                        return;
                    }
                    for (const entry of entries) {
                        if (truncated) return;
                        const abs = join(dir, entry.name);
                        if (!isPathWithin(abs, allowed)) continue;
                        if (entry.isDirectory()) {
                            await walk(abs);
                            continue;
                        }
                        if (!entry.isFile()) continue;
                        const rel = abs
                            .slice(allowed.length + 1)
                            .split(sep)
                            .join(posix.sep);
                        if (input.glob && !matchesGlob(rel, input.glob)) continue;
                        let stat;
                        try {
                            stat = await fs.stat(abs);
                        } catch {
                            continue;
                        }
                        if (stat.size > MAX_FILE_BYTES) continue;
                        let content;
                        try {
                            content = await fs.readFile(abs, 'utf8');
                        } catch {
                            continue;
                        }
                        const lines = content.split('\n');
                        for (let i = 0; i < lines.length; i++) {
                            const hay = input.caseInsensitive ? lines[i].toLowerCase() : lines[i];
                            if (hay.includes(needle)) {
                                if (matches.length >= MAX_GREP_MATCHES) {
                                    truncated = true;
                                    return;
                                }
                                matches.push({
                                    path: rel,
                                    line: i + 1,
                                    text: lines[i].slice(0, 512),
                                });
                            }
                        }
                    }
                }
                await walk(allowed);
                return { matches, truncated };
            },
        }),
    );
}

// ─── Minimal glob matcher ────────────────────────────────────────────────
//
// Supports `*` (single segment, no `/`), `**` (any segments), `?` (single
// char), and literal text. Good enough for the common workspace patterns
// (`workflows/*.md`, `**/*.yaml`, etc.). Tiers needing the full
// minimatch surface can swap their handler.

function matchesGlob(path: string, pattern: string): boolean {
    const re = globToRegex(pattern);
    return re.test(path);
}

function globToRegex(pattern: string): RegExp {
    let out = '^';
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '*') {
            if (pattern[i + 1] === '*') {
                out += '.*';
                i += 1;
                if (pattern[i + 1] === '/') i += 1;
            } else {
                out += '[^/]*';
            }
        } else if (ch === '?') {
            out += '.';
        } else if (/[.+^${}()|[\]\\]/.test(ch)) {
            out += `\\${ch}`;
        } else {
            out += ch;
        }
    }
    out += '$';
    return new RegExp(out);
}
