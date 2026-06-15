import { runGit } from './run-git';
import { resolveWorkspaceStagePaths, buildStageAddArgs } from './settle-core';

/**
 * Stage + diff a unified patch for the named workspaces, with the master-fs
 * overlays (`extracted/`, `attached/`, `_results/`, `.derived-from-sha`)
 * excluded via pathspec.
 *
 * This is the patch shape the laptop transport sends across the wire to
 * the host's settle endpoint, and the same shape the server-side
 * `settleFromPatch` expects to apply under the bot identity. The mcp
 * transport (a remote MCP client) produces identical patches.
 *
 * Pathspec exclusions match the settle gate exactly — the exclusion set lives
 * in `settle-core` (`buildStageAddArgs`), so a laptop-transport patch can never
 * carry a generated/master-fs path a worktree settle would have stripped.
 *
 * Returns `parentSha` so the caller can send it alongside the patch —
 * the server uses it to detect fast-forward conflicts and respond with
 * `fast_forward_required` for the laptop transport to rebase and retry.
 */
export async function buildSettlePatch(
    workingTreeRoot: string,
    workspaces: ReadonlyArray<string>,
): Promise<{ patch: string; parentSha: string }> {
    // Nesting-/relocation-aware path resolution, shared with `settleFromWorktree`.
    const { stagePaths, diffPaths } = await resolveWorkspaceStagePaths(workingTreeRoot, workspaces);
    const addArgs = await buildStageAddArgs(workingTreeRoot, stagePaths);
    if (addArgs) await runGit(workingTreeRoot, addArgs);
    const patch = await runGit(workingTreeRoot, ['diff', '--cached', '--binary', '--', ...diffPaths]);
    const parentSha = (await runGit(workingTreeRoot, ['rev-parse', 'origin/main'])).trim();
    return { patch, parentSha };
}
