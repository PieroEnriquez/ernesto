/**
 * Shared settle TAIL — the lint → commit → bot-push → journal-rebase core that
 * every settle entry point runs once its changes are STAGED in the index.
 *
 * Three entry points stage by different means and then converge here:
 *   - `settleFromWorktree` — stages the working tree (Tier A/B agent run).
 *   - `settleFromPatch`    — `git apply --index` of a laptop unified diff (Tier C).
 *   - `settleFromOverlay`  — materializes a content-overlay into the tree and
 *                            stages it (editor server-side 3-way).
 *
 * Factoring the tail here keeps the lint+push contract in ONE place: the three
 * paths can never drift on which diff the lint sees, how trailers are formatted,
 * or how the post-push journal rebase is done. The staging strategy — the only
 * thing that differs — stays in each entry point.
 */

import { Workdir } from './types';
import { runGit } from './run-git';
import { scanWorkspaceBoundaries, boundaryForName } from '../workspaces/boundaries';
import type { LintFn, PushToMainFn, SettleResult } from './settle';

/** Tree-relative paths the lint diff is scoped to, resolved nesting-aware:
 *  each declared leaf maps to BOTH its conventional `workspaces/<leaf>` path
 *  and its current resolved location, so a relocation's rename is paired and a
 *  nested workspace's changes are not silently excluded from the gate. */
export async function resolveScopedPaths(
    root: string,
    workspaces: ReadonlyArray<string>,
): Promise<string[]> {
    const boundaries = await scanWorkspaceBoundaries(root);
    const wsPaths = new Set<string>();
    for (const w of workspaces) {
        wsPaths.add(`workspaces/${w}`);
        const resolved = boundaryForName(boundaries, w)?.dir;
        if (resolved) wsPaths.add(resolved);
    }
    return [...wsPaths];
}

export function formatCommitMessage(
    message: string,
    trailers?: Readonly<Record<string, string>>,
): string {
    if (!trailers || Object.keys(trailers).length === 0) return message;
    const trailerLines = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`);
    return `${message}\n\n${trailerLines.join('\n')}`;
}

export interface SettleCoreInput {
    workspaces: ReadonlyArray<string>;
    message: string;
    lint: LintFn;
    pushToMain?: PushToMainFn;
    trailers?: Readonly<Record<string, string>>;
    /** Scoped tree-relative paths to diff for the lint AND to reset on failure.
     *  Caller passes this (it already resolved them to stage); if omitted the
     *  core resolves them from `workspaces`. */
    scopedPaths?: ReadonlyArray<string>;
    /** How to undo the staged changes when the lint rejects them. The two
     *  existing entry points differ: worktree resets the index for the scoped
     *  paths (`reset HEAD -- …`); the apply/overlay paths hard-reset the whole
     *  ephemeral tree (`reset --hard HEAD`). */
    onLintFail: 'reset-paths' | 'reset-hard';
}

/**
 * Run the converged tail: diff the staged scope → lint → (on pass) commit with
 * trailers → optionally bot-push → rebase the journal branch onto new main.
 * Assumes the caller already staged its changes into the index under
 * `workdir.lock(…)`.
 */
export async function runSettleCore(
    workdir: Workdir,
    input: SettleCoreInput,
): Promise<SettleResult> {
    const root = workdir.workingTreeRoot;
    const scopedPaths = input.scopedPaths
        ? [...input.scopedPaths]
        : await resolveScopedPaths(root, input.workspaces);

    const diff = await runGit(root, ['diff', '--cached', '--', ...scopedPaths]);

    const lintRes = await input.lint({
        diff,
        workspaces: input.workspaces,
        workingTreeRoot: root,
    });
    if (!lintRes.ok) {
        if (input.onLintFail === 'reset-hard') {
            await runGit(root, ['reset', '--hard', 'HEAD']);
        } else {
            await runGit(root, ['reset', 'HEAD', '--', ...scopedPaths]);
        }
        return { ok: false, error: 'lint_failed', errors: lintRes.errors };
    }

    const commitMessage = formatCommitMessage(input.message, input.trailers);
    await runGit(root, ['commit', '-m', commitMessage]);
    const sha = (await runGit(root, ['rev-parse', 'HEAD'])).trim();

    if (!input.pushToMain) {
        return { ok: true, sha, pushed: false };
    }

    const push = await input.pushToMain({
        branchRef: workdir.branchRef,
        sha,
        message: input.message,
    });
    if (!push.ok) return push;

    // Rebase the journal branch onto the new main so subsequent settles on this
    // workdir don't trip a fast-forward error. Recoverable on failure: the
    // commit already landed on main.
    try {
        await runGit(root, ['fetch', '--quiet', 'origin', 'main']);
        await runGit(root, ['reset', '--hard', 'FETCH_HEAD']);
    } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('runSettleCore: post-push journal rebase failed', err);
    }

    return { ok: true, sha: push.sha, pushed: true };
}
