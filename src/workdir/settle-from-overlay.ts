/**
 * Editor settle path — reconcile a per-user CONTENT-OVERLAY against the CURRENT
 * server-side `main` with a real 3-way, then run the SAME lint → commit →
 * bot-push core as the other settle entry points.
 *
 * Why this is distinct from `settleFromPatch` (PROJECT.md §3.2): the laptop
 * transport owns its working tree, so a stale patch is rebased ON THE LAPTOP
 * (`fast_forward_required`). The EDITOR principal edits server-side — there is
 * no laptop to rebase on — so conflict resolution belongs here. We therefore
 * 3-way the overlay (authored against `patch.baseSha`) against current main and
 * SURFACE conflicts (`overlay_conflict`) rather than silently merging. A clean
 * 3-way is committed and pushed through the shared core.
 *
 * The 3-way uses `git merge-tree --write-tree`:
 *   - ours   = current `HEAD` (the workdir is synced to current main),
 *   - theirs = a commit carrying the overlay applied onto `baseSha`,
 *   - base   = found automatically (it is `baseSha`, an ancestor of both).
 * merge-tree reports a non-clean result with the conflicted paths; a clean
 * result yields the merged tree, which we materialize into the index and stage
 * for the shared lint+commit+push tail.
 */

import { rm } from 'fs/promises';
import { join } from 'path';
import { Workdir } from './types';
import { runGit, tryRunGit } from './run-git';
import { SettleResult, LintFn, PushToMainFn } from './settle';
import { runSettleCore, resolveScopedPaths } from './settle-core';
import type { WorkspacePatch, PatchEntry } from '../workspaces/overlay';

function isDeleted(e: PatchEntry): e is { deleted: true } {
    return (e as { deleted?: true }).deleted === true;
}

export interface SettleFromOverlayInput {
    workspaces: ReadonlyArray<string>;
    message: string;
    /** The durable per-user content-overlay to settle. */
    patch: WorkspacePatch;
    /** Master-FS revision the overlay was reconciled against. Must exist in the
     *  repo (it is the merge base for the 3-way). Defaults to `patch.baseSha`. */
    baseSha?: string;
    lint: LintFn;
    pushToMain?: PushToMainFn;
    trailers?: Readonly<Record<string, string>>;
    /** By-reference selection of draft paths to publish (tree-relative POSIX).
     *  AND-ed with the workspace scope — can only SHRINK the committed set, never
     *  widen it (`workspaces[]` stays the access boundary). Literal-membership
     *  only; no globs. Omitted (or empty) ⇒ publish-all in scope (today's
     *  behavior). The `['*']` publish-all sentinel is normalized to "omitted" by
     *  the CALLER (each backend surface) BEFORE calling this function, so the lib
     *  filter stays pure set-membership and never special-cases `"*"`. */
    files?: ReadonlyArray<string>;
}

export type SettleFromOverlayResult =
    | SettleResult
    /** `baseSha` = the overlay's merge base, `headSha` = the workdir HEAD the
     *  3-way ran against — carried so a conflict is diagnosable (genuine
     *  two-sided edit vs a drifted/stale base) without re-deriving either. */
    | { ok: false; error: 'overlay_conflict'; paths: ReadonlyArray<string>; baseSha: string; headSha: string }
    /** `reason` is one of: `empty_patch` (no draft entry in the declared
     *  `workspaces[]`), `empty_selection` (a non-empty `files` selection matched
     *  nothing in scope — distinct from `empty_patch` so the caller can tell
     *  "your files matched nothing" from "you have no draft here"), or
     *  `unknown_base_sha:<sha>` (the merge base does not exist in the repo). */
    | { ok: false; error: 'patch_rejected'; reason: string };

export async function settleFromOverlay(workdir: Workdir, input: SettleFromOverlayInput): Promise<SettleFromOverlayResult> {
    return workdir.lock(async () => {
        const root = workdir.workingTreeRoot;
        const baseSha = (input.baseSha ?? input.patch.baseSha).trim();

        // Scope the overlay to the declared `workspaces[]`: a per-user draft is
        // ONE overlay spanning every workspace the user has touched, but a settle
        // commits only its declared scope. Applying out-of-scope entries here
        // would over-commit them to main UNLINTED (the lint diff is scoped) and
        // leave the caller unable to tell what landed. Filtering to scope makes
        // settle honor its contract and yields a path-granular committed set the
        // caller forgets from the draft. (The same `resolveScopedPaths` the lint
        // core uses, so apply-scope and commit-scope can never drift.)
        const scopedPaths = await resolveScopedPaths(root, input.workspaces);
        const inScope = (p: string): boolean => scopedPaths.some((s) => p === s || p.startsWith(`${s}/`));
        // By-reference selection: AND the optional `files` set AFTER the
        // workspace scope so it can only SHRINK the committed set — the same
        // chokepoint owns apply-scope, lint-scope, and commit-scope, so they can
        // never drift. `sel === null` (omitted/empty) preserves exact current
        // whole-workspace behavior. Literal membership only (no glob).
        const sel = input.files && input.files.length > 0 ? new Set(input.files) : null;
        const inSelection = (p: string): boolean => sel === null || sel.has(p);
        const fileEntries = Object.entries(input.patch.files).filter(([p]) => inScope(p) && inSelection(p));
        if (fileEntries.length === 0) {
            // `empty_selection` = a non-empty `files` selection intersected the
            // in-scope draft to nothing; `empty_patch` = there is no draft in the
            // declared workspaces at all. Distinguished so the caller can guide
            // the agent (widen the selection vs. nothing to settle here).
            return { ok: false, error: 'patch_rejected', reason: sel ? 'empty_selection' : 'empty_patch' };
        }

        // The merge base must exist in this repo.
        const baseOk = await tryRunGit(root, ['cat-file', '-e', `${baseSha}^{commit}`]);
        if (!baseOk.ok) {
            return { ok: false, error: 'patch_rejected', reason: `unknown_base_sha:${baseSha}` };
        }

        const headSha = (await runGit(root, ['rev-parse', 'HEAD'])).trim();

        // Build the "theirs" commit: a worktree-free synthesis of baseSha's
        // tree with the overlay applied. We use a temporary index so we do not
        // disturb the workdir's real index/worktree before the 3-way decision.
        const tmpIndex = join(root, `.git`, `overlay-index-${Date.now()}`);
        const env = { GIT_INDEX_FILE: tmpIndex };
        let theirsSha: string;
        try {
            // Seed the temp index with baseSha's tree.
            await runGit(root, ['read-tree', baseSha], { env });
            // Apply the overlay: hash-object each present file, update-index;
            // remove each tombstone.
            for (const [path, entry] of fileEntries) {
                if (isDeleted(entry)) {
                    await tryRunGit(root, ['update-index', '--force-remove', '--', path], { env });
                } else {
                    const blob = (
                        await runGit(root, ['hash-object', '-w', '--stdin', '--path', path], { env, stdin: entry.content })
                    ).trim();
                    await runGit(root, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], { env });
                }
            }
            const theirsTree = (await runGit(root, ['write-tree'], { env })).trim();
            theirsSha = (await runGit(root, ['commit-tree', theirsTree, '-p', baseSha, '-m', 'overlay'], { env })).trim();
        } finally {
            await rm(tmpIndex, { force: true });
        }

        // 3-way: ours = HEAD (current main), theirs = overlay-on-base. The
        // merge base is baseSha (an ancestor of theirs and of HEAD's history).
        const merge = await tryRunGit(root, ['merge-tree', '--write-tree', '--name-only', headSha, theirsSha]);
        if (!merge.ok) {
            // Non-zero exit = conflicts. stdout is: <oid>\n\n<conflicted paths…>
            const out = (merge.stdout ?? '').trim();
            const lines = out.split('\n');
            // Drop the first line (the (unusable) tree oid) and any blank lines.
            const paths = lines
                .slice(1)
                .map((l) => l.trim())
                .filter((l) => l.length > 0);
            return { ok: false, error: 'overlay_conflict', paths, baseSha, headSha };
        }

        const mergedTree = merge.stdout.trim().split('\n')[0].trim();

        // Materialize the merged tree into the workdir's real index + worktree.
        // read-tree -m -u sets the index to the merged tree AND updates the
        // worktree to match — the overlay's changes are already staged for the
        // shared lint+commit core. No `add` follows: an `add -A` here would
        // re-stage untracked worktree leftovers (e.g. `attached/` hard links)
        // into the commit.
        await runGit(root, ['read-tree', '-m', '-u', mergedTree]);

        return runSettleCore(workdir, {
            workspaces: input.workspaces,
            message: input.message,
            lint: input.lint,
            pushToMain: input.pushToMain,
            trailers: input.trailers,
            scopedPaths,
            onLintFail: 'reset-hard',
        });
    });
}
