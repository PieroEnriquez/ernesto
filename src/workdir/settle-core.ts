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
import { runGit, tryRunGit } from './run-git';
import { stat } from 'fs/promises';
import * as nodePath from 'path';
import { scanWorkspaceBoundaries, boundaryForName, type WorkspaceBoundary } from '../workspaces/boundaries';
import type { LintFn, PushToMainFn, SettleResult } from './settle';

/**
 * Per-workspace subdirectories that are generated content (extraction worker,
 * attach route). They live as hard-link mirrors of master-fs placed at
 * host boot (deployer-owned — see the host's `ensureMasterFsOverlays`)
 * and must never enter the git index. settle excludes them from staging via
 * git pathspec. NOTE: some of these are ALSO `.gitignore`d in the workspaces
 * repo (the master-fs untrack: `extracted/`, `_results/`, `.derived-from-sha`),
 * others are not (`attached/`). `buildStageAddArgs` filters
 * the exclude pathspecs against `git check-ignore` because `git add -- <ws>
 * :(exclude)<p>` FAILS ("paths are ignored, use -f") when `<p>` is an existing,
 * gitignored path — even though it is only being excluded. git already skips
 * gitignored content during the `<ws>` dir-walk, so the exclude is redundant
 * (and fatal) for those; it is kept only for the non-ignored generated paths,
 * where it is still required to keep them out of the index. Keep this list in
 * sync with the lint's `forbidden_generated_path` rule.
 *
 * `routes/` is not in this list: the earlier parallel route catalog
 * (`routes/_index.md` + `routes/{slug}.md`) was removed in favour of two
 * auto-blocks inside each workspace's WORKSPACE.md, so there is no routes
 * subdir to exclude. WORKSPACE.md itself IS staged — the derive worker
 * re-asserts the auto-blocks on the next push, so a stale block self-heals.
 *
 * `_results` is the transient per-conversation route-result archive subtree the
 * `execute` verb writes (`workspaces/<w>/_results/*.json`). It is scratch state,
 * never author intent, and must NEVER be committed/pushed (it is also the FIX 1
 * contract: `_results` must not be settled). It was previously excluded only on
 * the overlay/fold paths (boundaries.ts / open-workdir / foldback already list
 * it); listing it HERE — the single source of truth `buildStageAddArgs` uses —
 * closes the worktree-settle path (`settleFromWorktree`, used by the in-process
 * agent `settle` verb), which would otherwise `git add` untracked `_results`
 * archives present in the worktree and push them to main.
 */
export const GENERATED_SUBDIRS = ['extracted', 'attached', '_results'] as const;

/**
 * Per-workspace single-file overlays mirrored from master-fs. Like
 * `GENERATED_SUBDIRS` but for individual files.
 *
 * `.derived-from-sha` is the per-workspace freshness sentinel written by
 * the derive worker into master-fs only (the `DERIVED_FROM_SHA_FILE`
 * marker; the derive worker runs on the in-process transport). It is
 * master-fs-canonical, must not enter git, and was historically leaking
 * in via `git add` because the exclusion list omitted it — every
 * refresh-from-main then conflicted on every workspace as soon as the
 * derive worker bumped the marker for a workspace touched by any settle.
 * Listing it here keeps future settles clean; cleanup of the existing
 * tracked copies is a one-shot `git rm` elsewhere.
 *
 * `attachments.yaml` is deliberately NOT in this list: it lives in git
 * like any prose file — attach/detach author it as a pending draft edit
 * of the calling session, and settle stages and commits it normally.
 */
export const GENERATED_FILES = ['.derived-from-sha'] as const;

/** Tree-relative paths the lint diff is scoped to, resolved nesting-aware:
 *  each declared leaf maps to BOTH its conventional `workspaces/<leaf>` path
 *  and its current resolved location, so a relocation's rename is paired and a
 *  nested workspace's changes are not silently excluded from the gate.
 *
 *  `extraBoundaries` lets a caller add boundaries the tree at `root` cannot
 *  know yet — the overlay settle passes the boundaries its patch declares, so
 *  a sub-workspace being CREATED in that settle resolves by its own leaf name
 *  (parity with the worktree path, whose scan sees the authored files). */
export async function resolveScopedPaths(
    root: string,
    workspaces: ReadonlyArray<string>,
    extraBoundaries: ReadonlyArray<WorkspaceBoundary> = [],
): Promise<string[]> {
    const boundaries = [...(await scanWorkspaceBoundaries(root)), ...extraBoundaries];
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
        stat(nodePath.join(root, rel)).then(
            () => true,
            () => false,
        );
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
 * Of `candidates`, return the subset git currently IGNORES (untracked AND
 * matched by a `.gitignore` rule), batched into one `git check-ignore --stdin`
 * call. `check-ignore` exits 1 when nothing matches (not an error) and prints
 * the matched paths to stdout — `tryRunGit` preserves stdout on the non-zero
 * branch, so we read it either way. It also respects the index: a TRACKED file
 * that matches a pattern is reported NOT ignored (git never ignores tracked
 * files), so such a path stays excluded — exactly what we want.
 */
async function gitIgnoredSubset(root: string, candidates: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    if (candidates.length === 0) return new Set();
    const r = await tryRunGit(root, ['check-ignore', '--stdin'], {
        stdin: candidates.join('\n'),
    });
    return new Set(
        r.stdout
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
    );
}

/**
 * Build the `git add -- …` argument list that stages each path minus its
 * master-fs overlays. `extracted/`/`attached/`/`_results/` (subdirs) and
 * `.derived-from-sha` (file) are generated/master-fs
 * mirrors that must never enter the git index. We exclude them via pathspec —
 * EXCEPT for those git already `.gitignore`s: naming an existing gitignored
 * path in a pathspec (even an `:(exclude)` one) makes `git add` fail with "the
 * following paths are ignored … use -f", which broke every settle/open-workdir
 * staging after the master-fs untrack landed the `.gitignore`. git already
 * skips gitignored content during the inclusive `<ws>` dir-walk, so for those
 * paths the exclude is redundant; we drop it (see `gitIgnoredSubset`) and keep
 * it only for the still-tracked / not-ignored generated paths. Returns `null`
 * when there is nothing to stage.
 *
 * Single source of truth for the exclusion set so the worktree, laptop-patch,
 * and overlay settle paths can never drift on which generated paths get
 * stripped. `root` is the repo whose `.gitignore`/index the filter is
 * evaluated against.
 */
export async function buildStageAddArgs(root: string, stagePaths: ReadonlyArray<string>): Promise<string[] | null> {
    if (stagePaths.length === 0) return null;
    const candidates: string[] = [];
    for (const p of stagePaths) {
        for (const sub of GENERATED_SUBDIRS) candidates.push(`${p}/${sub}`);
        for (const file of GENERATED_FILES) candidates.push(`${p}/${file}`);
    }
    const ignored = await gitIgnoredSubset(root, candidates);
    const addArgs = ['add', '--'];
    for (const p of stagePaths) {
        addArgs.push(p);
        for (const sub of GENERATED_SUBDIRS) {
            const c = `${p}/${sub}`;
            if (!ignored.has(c)) addArgs.push(`:(exclude)${c}`);
        }
        for (const file of GENERATED_FILES) {
            const c = `${p}/${file}`;
            if (!ignored.has(c)) addArgs.push(`:(exclude)${c}`);
        }
    }
    return addArgs;
}

export function formatCommitMessage(message: string, trailers?: Readonly<Record<string, string>>): string {
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
export async function runSettleCore(workdir: Workdir, input: SettleCoreInput): Promise<SettleResult> {
    const root = workdir.workingTreeRoot;
    const scopedPaths = input.scopedPaths ? [...input.scopedPaths] : await resolveScopedPaths(root, input.workspaces);

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

    // Ground-truth committed scope: the staged paths within the lint scope, just
    // before the commit. Path-granular so a caller can forget exactly the
    // settled subset of a per-user draft (not the whole draft).
    const committedPaths = (await runGit(root, ['diff', '--cached', '--name-only', '-z', '--', ...scopedPaths]))
        .split('\0')
        .filter((p) => p.length > 0);

    const commitMessage = formatCommitMessage(input.message, input.trailers);
    await runGit(root, ['commit', '-m', commitMessage]);
    const sha = (await runGit(root, ['rev-parse', 'HEAD'])).trim();

    if (!input.pushToMain) {
        return { ok: true, sha, pushed: false, committedPaths };
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

    return { ok: true, sha: push.sha, pushed: true, committedPaths };
}
