/**
 * Shared settle TAIL — the lint → commit → bot-push → journal-rebase core that
 * every settle entry point runs once its changes are STAGED in the index.
 *
 * Three entry points stage by different means and then converge here:
 *   - `settleFromWorktree` — stages the working tree (in-process / mcp transport agent run).
 *   - `settleFromPatch`    — `git apply --index` of a laptop unified diff (laptop transport).
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
import { stat } from 'fs/promises';
import * as nodePath from 'path';
import { scanWorkspaceBoundaries, boundaryForName } from '../workspaces/boundaries';
import type { LintFn, PushToMainFn, SettleResult } from './settle';

/**
 * Per-workspace subdirectories that are generated content (extraction worker,
 * attach route). They live as hard-link mirrors of master-fs placed at
 * session boot (deployer-owned — see the host's `ensureMasterFsOverlays`)
 * and must never enter the git index. settle excludes them from staging via
 * git pathspec, regardless of any `.gitignore` rules — the workspaces tree's
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
export const GENERATED_SUBDIRS = ['extracted', 'attached'] as const;

/**
 * Per-workspace single-file overlays mirrored from master-fs. Like
 * `GENERATED_SUBDIRS` but for individual files. `attachments.yaml` is
 * authored only by `_platform://attach` and `_platform://detach`, which
 * write atomically to master-fs; the workdir copy is a hard link mirrored
 * by `ensureMasterFsOverlays` at session boot and `remirrorFile`
 * mid-session. Settle must not stage it — the bytes the agent might see
 * in git status are master-fs state, not author intent.
 *
 * The target state has `attachments.yaml` living in git (workdir-authored,
 * settled normally). The route still writes the yaml to master-fs today, so
 * the exclusion stays until the route flip lands; otherwise sibling-session
 * attaches would leak via the overlay.
 *
 * `.derived-from-sha` is the per-workspace freshness sentinel written by
 * the derive worker into master-fs only (the `DERIVED_FROM_SHA_FILE`
 * marker; the derive worker runs on the in-process transport). It is
 * master-fs-canonical, must
 * not enter git, and was historically leaking in via `git add` because
 * the exclusion list omitted it — every refresh-from-main then conflicted
 * on every workspace as soon as the derive worker bumped the marker for
 * a workspace touched by any settle. Listing it here keeps future settles
 * clean; cleanup of the existing tracked copies is a one-shot `git rm`
 * elsewhere.
 */
export const GENERATED_FILES = ['attachments.yaml', '.derived-from-sha'] as const;

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

/**
 * Resolve each declared workspace (by leaf identity) to BOTH:
 *   - `stagePaths`: the on-disk paths that EXIST (the resolved current
 *     location and/or the conventional `workspaces/<leaf>` path) — these are
 *     what `git add` is pointed at. The old `git add workspaces/<name>`
 *     assumption fatals the moment a workspace is nested (`hr/recruiting`) or
 *     has just been `git mv`-ed away — the path no longer exists. We instead
 *     stage the path that EXISTS.
 *   - `diffPaths`: BOTH the conventional top-level path AND the resolved path
 *     for EVERY declared workspace (existence-independent), so a relocation's
 *     rename (old → new) is paired and its deletion side is linted.
 *
 * Shared by `settleFromWorktree` and `buildSettlePatch` so the two never drift
 * on which paths get staged vs diffed.
 */
export async function resolveWorkspaceStagePaths(
    root: string,
    workspaces: ReadonlyArray<string>,
): Promise<{ stagePaths: string[]; diffPaths: string[] }> {
    const boundaries = await scanWorkspaceBoundaries(root);
    const exists = (rel: string): Promise<boolean> =>
        stat(nodePath.join(root, rel)).then(() => true, () => false);
    const stagePaths: string[] = [];
    const diffPaths = new Set<string>();
    for (const w of workspaces) {
        const conventional = `workspaces/${w}`;
        const resolved = boundaryForName(boundaries, w)?.dir;
        diffPaths.add(conventional);
        if (resolved) diffPaths.add(resolved);
        // Prefer the resolved (current) path; include the conventional one only
        // when it still exists on disk (flat layout, or the not-moved case). A
        // moved-away conventional path is left to its already-staged deletion.
        for (const p of new Set([resolved, conventional].filter((x): x is string => !!x))) {
            if (await exists(p)) stagePaths.push(p);
        }
    }
    return { stagePaths, diffPaths: [...diffPaths] };
}

/**
 * Build the `git add -- …` argument list that stages each path minus its
 * master-fs overlays. `extracted/` and `attached/` (subdirs) and
 * `attachments.yaml` + `.derived-from-sha` (files) are hard-link mirrors of
 * master-fs placed at session boot (deployer-owned: the host's
 * `ensureMasterFsOverlays`); they must never enter the git index. Doing the
 * exclusion via pathspec here (instead of via the workspaces tree's
 * `.gitignore`) keeps the working tree discoverable to ripgrep-based tools
 * (`fs_glob`, `fs_grep`) — ripgrep reads .gitignore and would silently skip
 * these paths, hiding the mirrored master-fs content. Only git treats them as
 * out-of-bounds. Returns `null` when there is nothing to stage.
 *
 * Single source of truth for the exclusion set so the worktree, laptop-patch,
 * and overlay settle paths can never drift (a missing exclusion here once let
 * `attachments.yaml` ride along in laptop-transport patches a worktree settle
 * would have stripped).
 */
export function buildStageAddArgs(stagePaths: ReadonlyArray<string>): string[] | null {
    if (stagePaths.length === 0) return null;
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
    return addArgs;
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
