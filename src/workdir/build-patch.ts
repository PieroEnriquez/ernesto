import { runGit } from './run-git';

/**
 * Stage + diff a unified patch for the named workspaces, with the
 * `extracted/` and `attached/` subtrees excluded via pathspec.
 *
 * This is the patch shape the Tier-C laptop sends across the wire to
 * `/ernesto/tier-c/settle`, and the same shape the server-side
 * `settleFromPatch` expects to apply under the bot identity. Future
 * Tier-B (claude.ai integration) will produce identical patches.
 *
 * Pathspec exclusions match the §22 settle gate: `extracted/` is rebuilt
 * by the derive worker, `attached/` is hard-linked from master-fs and
 * has its own routing (`_platform://attach`); neither belongs in the
 * dev's settle commit.
 *
 * Returns `parentSha` so the caller can send it alongside the patch —
 * the server uses it to detect fast-forward conflicts and respond with
 * `fast_forward_required` for the CLI to rebase and retry.
 */
export async function buildSettlePatch(
    workingTreeRoot: string,
    workspaces: ReadonlyArray<string>,
): Promise<{ patch: string; parentSha: string }> {
    const addArgs = ['add', '--'];
    for (const w of workspaces) {
        addArgs.push(`workspaces/${w}`);
        addArgs.push(`:(exclude)workspaces/${w}/extracted`);
        addArgs.push(`:(exclude)workspaces/${w}/attached`);
        // Master-fs-managed sentinel; never belongs in a Tier-C settle patch.
        // Keep in lockstep with `settle.ts`'s `GENERATED_FILES`.
        addArgs.push(`:(exclude)workspaces/${w}/.derived-from-sha`);
    }
    await runGit(workingTreeRoot, addArgs);
    const patch = await runGit(workingTreeRoot, ['diff', '--cached', '--binary', '--']);
    const parentSha = (await runGit(workingTreeRoot, ['rev-parse', 'origin/main'])).trim();
    return { patch, parentSha };
}
