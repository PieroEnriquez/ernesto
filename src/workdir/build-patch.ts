import { runGit } from './run-git';
import { stat } from 'fs/promises';
import * as nodePath from 'path';
import { scanWorkspaceBoundaries, boundaryForName } from '../workspaces/boundaries';

/**
 * Stage + diff a unified patch for the named workspaces, with the
 * `extracted/` and `attached/` subtrees excluded via pathspec.
 *
 * This is the patch shape the laptop transport sends across the wire to
 * the host's settle endpoint, and the same shape the server-side
 * `settleFromPatch` expects to apply under the bot identity. The mcp
 * transport (a remote MCP client) produces identical patches.
 *
 * Pathspec exclusions match the settle gate: `extracted/` is rebuilt
 * by the derive worker, `attached/` is hard-linked from master-fs and
 * has its own routing (`_platform://attach`); neither belongs in the
 * dev's settle commit.
 *
 * Returns `parentSha` so the caller can send it alongside the patch —
 * the server uses it to detect fast-forward conflicts and respond with
 * `fast_forward_required` for the laptop transport to rebase and retry.
 */
export async function buildSettlePatch(
    workingTreeRoot: string,
    workspaces: ReadonlyArray<string>,
): Promise<{ patch: string; parentSha: string }> {
    // Resolve each declared workspace (by leaf identity) to its CURRENT
    // location — nesting-/relocation-aware, mirroring `settleFromWorktree`.
    // The old `git add workspaces/<name>` fatals the moment a workspace is
    // nested (`hr/recruiting`) or has just been `git mv`-ed away. Stage the
    // path that EXISTS; diff over both the conventional top-level path AND the
    // resolved path so a relocation's rename (old → new) is captured in the
    // patch and its deletion side isn't dropped.
    const boundaries = await scanWorkspaceBoundaries(workingTreeRoot);
    const exists = (rel: string): Promise<boolean> =>
        stat(nodePath.join(workingTreeRoot, rel)).then(() => true, () => false);
    const stagePaths: string[] = [];
    const diffPaths = new Set<string>();
    for (const w of workspaces) {
        const conventional = `workspaces/${w}`;
        const resolved = boundaryForName(boundaries, w)?.dir;
        diffPaths.add(conventional);
        if (resolved) diffPaths.add(resolved);
        for (const p of new Set([resolved, conventional].filter((x): x is string => !!x))) {
            if (await exists(p)) stagePaths.push(p);
        }
    }
    const addArgs = ['add', '--'];
    for (const p of stagePaths) {
        addArgs.push(p);
        addArgs.push(`:(exclude)${p}/extracted`);
        addArgs.push(`:(exclude)${p}/attached`);
        // Master-fs-managed sentinel; never belongs in a laptop-transport settle patch.
        // Keep in lockstep with `settle.ts`'s `GENERATED_FILES`.
        addArgs.push(`:(exclude)${p}/.derived-from-sha`);
    }
    if (stagePaths.length > 0) await runGit(workingTreeRoot, addArgs);
    const patch = await runGit(workingTreeRoot, ['diff', '--cached', '--binary', '--', ...diffPaths]);
    const parentSha = (await runGit(workingTreeRoot, ['rev-parse', 'origin/main'])).trim();
    return { patch, parentSha };
}
