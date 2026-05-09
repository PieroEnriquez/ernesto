import { Workdir } from './types';
import { runGit } from './run-git';

export interface LintError {
    code: string;
    workspace?: string;
    path?: string;
    message: string;
}

export interface LintInput {
    /** Unified diff of staged changes against `origin/main`, scoped to `workspaces`. */
    diff: string;
    workspaces: ReadonlyArray<string>;
}

export type LintFn = (input: LintInput) => Promise<
    | { ok: true }
    | { ok: false; errors: ReadonlyArray<LintError> }
>;

/** Bot-side push. Deployer wires this; the lib calls it under the lock. */
export type PushToMainFn = (input: {
    branchRef: string;
    sha: string;
    message: string;
}) => Promise<
    | { ok: true; sha: string }
    | { ok: false; error: 'fast_forward_required'; currentSha: string }
    | { ok: false; error: 'merge_conflict' }
>;

export interface SettleInput {
    workspaces: ReadonlyArray<string>;
    message: string;
    lint: LintFn;
    /** If omitted, settle stops after the local commit and returns the sha;
     *  the caller (e.g. tests, or a deployer that runs lint-only) handles push. */
    pushToMain?: PushToMainFn;
    /** Trailers to add to the commit (e.g. Workdir-Id, User, Tier). */
    trailers?: Readonly<Record<string, string>>;
}

export type SettleResult =
    | { ok: true; sha: string; pushed: boolean }
    | { ok: false; error: 'lint_failed'; errors: ReadonlyArray<LintError> }
    | { ok: false; error: 'fast_forward_required'; currentSha: string }
    | { ok: false; error: 'merge_conflict' };

/**
 * Tier A/B settle: stage `workspaces[]` from the working tree, run lint, commit
 * with trailers, optionally hand the resulting sha to the deployer's bot push.
 *
 * The lib does NOT hold bot credentials or perform `git push origin main`
 * directly — the deployer's `pushToMain` callback is the only thing that
 * touches the upstream. This keeps the lib free of credential plumbing and
 * makes the settle gate testable end-to-end without any network.
 *
 * Always runs under `workdir.lock(…)`.
 */
export async function settleFromWorktree(
    workdir: Workdir,
    input: SettleInput,
): Promise<SettleResult> {
    return workdir.lock(async () => {
        const root = workdir.workingTreeRoot;
        const wsPaths = input.workspaces.map(w => `workspaces/${w}`);

        await runGit(root, ['add', '--', ...wsPaths]);

        const diff = await runGit(root, [
            'diff', '--cached', '--', ...wsPaths,
        ]);

        const lintRes = await input.lint({ diff, workspaces: input.workspaces });
        if (!lintRes.ok) {
            await runGit(root, ['reset', 'HEAD', '--', ...wsPaths]);
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
        return { ok: true, sha: push.sha, pushed: true };
    });
}

function formatCommitMessage(
    message: string,
    trailers?: Readonly<Record<string, string>>,
): string {
    if (!trailers || Object.keys(trailers).length === 0) return message;
    const trailerLines = Object.entries(trailers).map(([k, v]) => `${k}: ${v}`);
    return `${message}\n\n${trailerLines.join('\n')}`;
}
