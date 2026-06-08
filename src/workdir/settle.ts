import { Workdir } from './types';
import { runGit } from './run-git';
import { runSettleCore, resolveWorkspaceStagePaths, buildStageAddArgs } from './settle-core';

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
    /** Absolute path to the working tree root. Lint can read sibling files
     *  (e.g. a workspace's current `WORKSPACE.md` to evaluate the §12 visibility rule). */
    workingTreeRoot: string;
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
    /** Trailers to add to the commit (e.g. Workdir-Id, User, transport). */
    trailers?: Readonly<Record<string, string>>;
}

export type SettleResult =
    | {
          ok: true;
          sha: string;
          pushed: boolean;
          /** Tree-relative paths actually committed by this settle (the staged
           *  scope). Path-granular ground truth — lets a caller forget exactly
           *  the settled subset of a per-user draft (rather than the whole
           *  draft) and is the seam a future finer-than-workspace settle hangs
           *  off. */
          committedPaths: ReadonlyArray<string>;
      }
    | { ok: false; error: 'lint_failed'; errors: ReadonlyArray<LintError> }
    | { ok: false; error: 'fast_forward_required'; currentSha: string }
    | { ok: false; error: 'merge_conflict' };

/**
 * Worktree settle (in-process and mcp transports): stage `workspaces[]` from
 * the working tree, run lint, commit with trailers, optionally hand the
 * resulting sha to the deployer's bot push.
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

        // Resolve each declared workspace (by identity = leaf name) to its
        // CURRENT location, honoring nesting and relocation. `stagePaths` are
        // the on-disk paths to `git add`; `diffPaths` are scoped to BOTH the
        // conventional and resolved locations so a relocation's rename
        // (old → new) is paired and its deletions are linted.
        const { stagePaths, diffPaths } = await resolveWorkspaceStagePaths(root, input.workspaces);

        // Stage each resolved path minus its master-fs overlays (the shared
        // exclusion set in settle-core, kept in lockstep with the laptop-patch
        // and overlay paths).
        const addArgs = await buildStageAddArgs(root, stagePaths);
        if (addArgs) await runGit(root, addArgs);

        // Converge on the shared lint → commit → push → journal-rebase tail.
        // The lint diff is scoped to the same paths we staged; a lint failure
        // un-stages just those paths (the working tree is the dev's, not an
        // ephemeral apply target, so we never hard-reset it).
        return runSettleCore(workdir, {
            workspaces: input.workspaces,
            message: input.message,
            lint: input.lint,
            pushToMain: input.pushToMain,
            trailers: input.trailers,
            scopedPaths: diffPaths,
            onLintFail: 'reset-paths',
        });
    });
}
