/**
 * Workspace boundary resolution — the one FS-derived primitive that maps a
 * workspace's *identity* (its leaf name) to its current *location* (a path),
 * at any nesting depth.
 *
 * Design (workspace-nesting refactor, "FS-derived identity"):
 *   - A directory under `workspaces/` is a workspace BOUNDARY iff it carries a
 *     `WORKSPACE.md`, at any depth. A nested sub-workspace (`hr/recruiting`)
 *     is a boundary just like a top-level one.
 *   - A workspace's identity is its LEAF basename (`recruiting`) — globally
 *     unique, equal to its route scheme and scope prefix. Location is the only
 *     thing nesting changes.
 *   - The graph of boundaries is a PURE FUNCTION of the filesystem. There is no
 *     authored side-table that could drift from disk: identity is *derived*,
 *     never declared. This is what keeps "concept" and "path" from
 *     decorrelating — the only dynamic fact is *where* a boundary currently
 *     sits, and that is read straight off the tree.
 *
 * Every layer that needs name→path or path→name (settle staging, the workflow
 * reader, agent visibility, route handlers) must resolve through here rather
 * than hardcoding `workspaces/<name>/…`. A relocation then re-resolves; nothing
 * downstream encodes the old location.
 */

import { readdir } from 'fs/promises';
import * as path from 'path';

export interface WorkspaceBoundary {
    /** Leaf basename — the workspace's identity (route scheme + scope prefix). */
    name: string;
    /** Posix path of the dir carrying `WORKSPACE.md`, relative to the tree root
     *  (e.g. `workspaces/hr/recruiting`). */
    dir: string;
}

/** Subdirectories never descended into while hunting for boundaries: master-FS
 *  mirrors (`extracted/`, `attached/`), generated output (`_results/`), and
 *  archived content (`archive/`). None host a live sub-workspace, and
 *  `extracted/` can be large. Mirrors the workflow reader's prune set. */
const PRUNE_DIRS = new Set([
    'extracted', 'attached', '_results', 'archive', 'node_modules', '.git',
]);

/**
 * Recursively collect every workspace boundary under `<workingTreeRoot>/workspaces/`.
 * Reads the working tree (so it reflects the to-be-committed state, including a
 * just-`git mv`-ed relocation). `workspaces/` itself is not a boundary.
 */
export async function scanWorkspaceBoundaries(
    workingTreeRoot: string,
): Promise<WorkspaceBoundary[]> {
    const out: WorkspaceBoundary[] = [];

    async function walk(relDir: string): Promise<void> {
        let entries: Array<import('fs').Dirent>;
        try {
            entries = await readdir(path.join(workingTreeRoot, relDir), { withFileTypes: true });
        } catch {
            return; // unreadable dir — skip
        }
        if (entries.some((e) => e.isFile() && e.name === 'WORKSPACE.md')) {
            out.push({ name: relDir.split('/').pop()!, dir: relDir });
        }
        for (const e of entries) {
            if (!e.isDirectory() || PRUNE_DIRS.has(e.name)) continue;
            await walk(`${relDir}/${e.name}`);
        }
    }

    let top: Array<import('fs').Dirent>;
    try {
        top = await readdir(path.join(workingTreeRoot, 'workspaces'), { withFileTypes: true });
    } catch {
        return out; // no workspaces/ dir
    }
    for (const e of top) {
        if (e.isDirectory() && !PRUNE_DIRS.has(e.name)) await walk(`workspaces/${e.name}`);
    }
    return out;
}

/**
 * Resolve a workspace's leaf name to its current boundary. Leaf names are
 * globally unique (lint-enforced), so the first match is authoritative; if a
 * duplicate ever slipped through, the shallowest wins (deterministic).
 */
export function boundaryForName(
    boundaries: readonly WorkspaceBoundary[],
    name: string,
): WorkspaceBoundary | undefined {
    let best: WorkspaceBoundary | undefined;
    for (const b of boundaries) {
        if (b.name !== name) continue;
        if (!best || b.dir.length < best.dir.length) best = b;
    }
    return best;
}

/**
 * The deepest boundary that is an ancestor-or-self of `p`. This is the
 * path→identity direction: which workspace owns this path, honoring nesting
 * (a path under `hr/recruiting/` belongs to `recruiting`, not `hr`).
 */
export function boundaryForPath(
    boundaries: readonly WorkspaceBoundary[],
    p: string,
): WorkspaceBoundary | undefined {
    let best: WorkspaceBoundary | undefined;
    for (const b of boundaries) {
        if (p === b.dir || p.startsWith(b.dir + '/')) {
            if (!best || b.dir.length > best.dir.length) best = b;
        }
    }
    return best;
}
