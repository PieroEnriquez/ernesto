/**
 * Compute the set of workspaces a principal can read, and attribute a path to
 * the workspace that owns it — both honoring arbitrary nesting depth.
 *
 * Spec: domains/workspaces/README.md §3 (Visibility) + §12 (read/write/admin
 * scopes).
 *
 * The read decision is delegated to the canonical access model
 * (`./access`), so the overlay matches exactly what the settle gate would
 * allow — the two can no longer drift.
 *
 * Identity is FS-derived: a directory carrying a `WORKSPACE.md` is a boundary at
 * any depth, and its identity is its LEAF basename (`hr/recruiting` →
 * `recruiting`). `scanWorkspaceBoundaries` walks the tree; `boundaryForPath`
 * maps a path to the DEEPEST boundary that owns it, so nesting a restricted
 * workspace under a public parent does not leak it.
 *
 * Per-boundary readability (against that boundary's own WORKSPACE.md):
 *   - reserved system workspaces (`RESERVED_SYSTEM_WORKSPACES`) are always
 *     readable;
 *   - `opts.isAdmin` (the caller's bypass — agent-ops, or the support preview)
 *     sees everything;
 *   - otherwise the canonical `canRead(fm, scopes)` decides.
 *
 * A WORKSPACE.md that cannot be read is FAIL-CLOSED (treated as not readable) —
 * better to silently trim than to leak a workspace whose ACL we couldn't read.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import {
    scanWorkspaceBoundaries,
    boundaryForPath,
    type WorkspaceBoundary,
} from './boundaries';
import { RESERVED_SYSTEM_WORKSPACES } from '../lint/lint-workspace';
import { parseWorkspaceFrontmatter, canRead } from './access';

const WORKSPACE_MD = 'WORKSPACE.md';
const PLATFORM_WORKSPACE = '_platform';

/**
 * A principal's read view of the workspace tree.
 *   - `all`           — every boundary on disk, any depth. The full set is
 *                       required for path→identity attribution (a restricted
 *                       child is still a boundary even when unreadable).
 *   - `readableNames` — leaf names of the boundaries this principal may read.
 *                       The actual gate.
 */
export interface WorkspaceVisibility {
    all: WorkspaceBoundary[];
    readableNames: Set<string>;
}

export interface ComputeWorkspaceVisibilityOptions {
    /** Caller-resolved admin bypass (agent-ops, or the support preview): when
     *  true, every boundary is readable. The access model never decides this. */
    isAdmin: boolean;
}

/**
 * Scan the workspace tree rooted at `treeRoot` (the dir that contains
 * `workspaces/`) and resolve which boundaries the principal — identified by its
 * `scopes` set — may read. With no boundaries on disk, returns empty `all` and
 * `readableNames` containing only `_platform` (so agent boot's symlink target
 * never dangles).
 */
export async function computeWorkspaceVisibility(
    treeRoot: string,
    scopes: ReadonlySet<string>,
    opts: ComputeWorkspaceVisibilityOptions,
): Promise<WorkspaceVisibility> {
    const all = await scanWorkspaceBoundaries(treeRoot);
    if (all.length === 0) {
        return { all, readableNames: new Set([PLATFORM_WORKSPACE]) };
    }

    const readableNames = new Set<string>();
    for (const boundary of all) {
        if (RESERVED_SYSTEM_WORKSPACES.has(boundary.name) || opts.isAdmin) {
            readableNames.add(boundary.name);
            continue;
        }
        let body: string;
        try {
            body = await readFile(join(treeRoot, boundary.dir, WORKSPACE_MD), 'utf8');
        } catch {
            // Fail-closed: an unreadable WORKSPACE.md is not readable.
            continue;
        }
        if (canRead(parseWorkspaceFrontmatter(body), scopes)) {
            readableNames.add(boundary.name);
        }
    }
    return { all, readableNames };
}

/**
 * The leaf name of the deepest boundary that owns `rel` (a `workspaces/…`
 * tree-relative path), or `null` if the path lies under no boundary.
 */
export function workspaceForPath(vis: WorkspaceVisibility, rel: string): string | null {
    return boundaryForPath(vis.all, rel)?.name ?? null;
}

/**
 * May the principal read the file at `rel`? Attributes the path to its deepest
 * boundary, then checks that boundary's readability. Out-of-tree paths and
 * paths owned by an unreadable boundary both return false.
 */
export function canReadPath(vis: WorkspaceVisibility, rel: string): boolean {
    const name = workspaceForPath(vis, rel);
    return name !== null && vis.readableNames.has(name);
}

/**
 * The boundaries the principal may read — for consumers that must LOCATE files
 * on disk. Each carries its `dir`, so callers resolve location through the
 * boundary, never `join('workspaces', name)`.
 */
export function readableBoundaries(vis: WorkspaceVisibility): WorkspaceBoundary[] {
    return vis.all.filter((b) => vis.readableNames.has(b.name));
}

/**
 * The tree-relative dirs of EVERY boundary. A recursive walker rooted at one
 * boundary uses this as a stop frontier so a public parent never spills a
 * restricted nested child.
 */
export function boundaryDirs(vis: WorkspaceVisibility): Set<string> {
    return new Set(vis.all.map((b) => b.dir));
}
