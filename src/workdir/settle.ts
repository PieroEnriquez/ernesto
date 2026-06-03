import { Workdir } from './types';
import { runGit } from './run-git';
import { stat } from 'fs/promises';
import * as nodePath from 'path';
import { scanWorkspaceBoundaries, boundaryForName } from '../workspaces/boundaries';
import { runSettleCore } from './settle-core';

/**
 * Per-workspace subdirectories that are generated content (extraction worker,
 * attach route). They live as hard-link mirrors of master-fs placed at
 * session boot (deployer-owned — see backend's `ensureMasterFsOverlays`)
 * and must never enter the git index. settle excludes them from staging via
 * git pathspec, regardless of any `.gitignore` rules — the workspaces repo's
 * `.gitignore` is deliberately empty of these because ripgrep (the engine
 * behind fs_glob/fs_grep) reads .gitignore and would silently skip them,
 * hiding master-fs-backed content from discovery. Keep this list in sync
 * with the lint's `forbidden_generated_path` rule.
 *
 * `routes/` is not in this list: the earlier parallel route catalog
 * (`routes/_index.md` + `routes/{slug}.md`) was removed in favour of two
 * auto-blocks inside each workspace's WORKSPACE.md, so there is no routes
 * subdir to exclude. WORKSPACE.md itself IS staged — the derive worker
 * re-asserts the auto-blocks on the next push, so a stale block self-heals.
 */
const GENERATED_SUBDIRS = ['extracted', 'attached'] as const;

/**
 * Per-workspace single-file overlays mirrored from master-fs. Like
 * `GENERATED_SUBDIRS` but for individual files. `attachments.yaml` is
 * authored only by `_platform://attach` and `_platform://detach`, which
 * write atomically to master-fs; the workdir copy is a hard link mirrored
 * by `ensureMasterFsOverlays` at session boot and `remirrorFile`
 * mid-session. Settle must not stage it — the bytes the agent might see
 * in git status are master-fs state, not author intent.
 *
 * Spec §3.5 describes the target state where `attachments.yaml` lives in
 * git (workdir-authored, settled normally). The route still writes the
 * yaml to master-fs today, so the exclusion stays until the route flip
 * lands; otherwise sibling-session attaches would leak via the overlay.
 *
 * `.derived-from-sha` is the per-workspace freshness sentinel written by
 * the derive worker into master-fs only (see
 * `tier-shared/master-fs-overlays.ts`'s `DERIVED_FROM_SHA_FILE` and the
 * worker at `tier-a/derive-worker.ts`). It is master-fs-canonical, must
 * not enter git, and was historically leaking in via `git add` because
 * the exclusion list omitted it — every refresh-from-main then conflicted
 * on every workspace as soon as the derive worker bumped the marker for
 * a workspace touched by any settle. Listing it here keeps future settles
 * clean; cleanup of the existing tracked copies is a one-shot `git rm`
 * elsewhere.
 */
const GENERATED_FILES = ['attachments.yaml', '.derived-from-sha'] as const;

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

        // Resolve each declared workspace (by identity = leaf name) to its
        // CURRENT location, honoring nesting and relocation. The old
        // `workspaces/<name>` assumption breaks the moment a workspace is
        // nested (`hr/recruiting`) or has just been `git mv`-ed — the path no
        // longer exists, so `git add workspaces/<name>` would fatal. We instead
        // stage the path that EXISTS, and diff over BOTH the conventional
        // top-level path AND the resolved path so a relocation's rename
        // (old → new) is paired and its deletions are linted.
        const boundaries = await scanWorkspaceBoundaries(root);
        const exists = async (rel: string): Promise<boolean> =>
            stat(nodePath.join(root, rel)).then(() => true, () => false);
        const stagePaths: string[] = [];
        const diffPaths = new Set<string>();
        for (const ws of input.workspaces) {
            const conventional = `workspaces/${ws}`;
            const resolved = boundaryForName(boundaries, ws)?.dir;
            diffPaths.add(conventional);
            if (resolved) diffPaths.add(resolved);
            // Prefer the resolved (current) path; include the conventional one
            // only when it still exists on disk (flat layout, or the not-moved
            // case). A moved-away conventional path is left to its already-
            // staged deletion (from the caller's `git mv`).
            for (const p of new Set([resolved, conventional].filter((x): x is string => !!x))) {
                if (await exists(p)) stagePaths.push(p);
            }
        }

        // Stage each resolved path minus its master-fs overlays. `extracted/`
        // and `attached/` (subdirs) and `attachments.yaml` (file) are
        // hard-link mirrors of master-fs placed at session boot (deployer-
        // owned: backend's `ensureMasterFsOverlays`); they must never enter
        // the git index. Doing the exclusion here (instead of via the
        // workspaces repo's `.gitignore`) keeps the working tree
        // discoverable to ripgrep-based tools (`fs_glob`, `fs_grep`) —
        // ripgrep reads .gitignore and would silently skip these paths,
        // hiding the mirrored master-fs content. Only git treats them as
        // out-of-bounds.
        const addArgs = ['add', '--'];
        for (const p of stagePaths) {
            addArgs.push(p);
            for (const sub of GENERATED_SUBDIRS) {
                addArgs.push(`:(exclude)${p}/${sub}`);
            }
            for (const file of GENERATED_FILES) {
                addArgs.push(`:(exclude)${p}/${file}`);
            }
        }
        if (stagePaths.length > 0) await runGit(root, addArgs);

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
            scopedPaths: [...diffPaths],
            onLintFail: 'reset-paths',
        });
    });
}
