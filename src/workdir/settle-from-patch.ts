/**
 * Tier-C settle path — apply a unified diff produced on the dev's laptop into
 * an ephemeral server-side workdir, run lint over the staged result, commit
 * with trailers, hand the resulting sha to the deployer's bot push.
 *
 * Contract:
 *   - The workdir's HEAD must equal `parentSha`. If not, we return
 *     `fast_forward_required` so the CLI can `git pull --rebase` on the
 *     laptop, regenerate the patch, and retry. We do NOT attempt to rebase
 *     server-side: the dev's working tree is on the laptop, the patch was
 *     authored against the laptop's view of main, and merging server-side
 *     would silently drop conflict resolution that should be the dev's.
 *
 *   - `git apply --index` is used (no --3way). If the patch doesn't apply
 *     cleanly against HEAD, we return `patch_rejected` with the apply error;
 *     the caller surfaces it to the dev as "rebase locally and retry".
 *
 *   - Lint runs against `git diff --cached`, identical to settleFromWorktree.
 *     Same lint, same gate.
 *
 *   - Push is the deployer's bot credential, identical to settleFromWorktree.
 *
 * Always runs under `workdir.lock(…)`.
 *
 * Spec: `src/ernesto/domains/workspaces/README.md` §22 (Tier C settle flow).
 */

import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { Workdir } from './types';
import { runGit } from './run-git';
import { SettleResult, LintFn, PushToMainFn, LintError } from './settle';
import { scanWorkspaceBoundaries, boundaryForName } from '../workspaces/boundaries';

export interface SettleFromPatchInput {
    workspaces: ReadonlyArray<string>;
    message: string;
    /** Unified diff as produced by `git diff --cached --binary` on the laptop. */
    patch: string;
    /** Sha the patch was generated against. Must equal the ephemeral workdir's HEAD. */
    parentSha: string;
    lint: LintFn;
    pushToMain?: PushToMainFn;
    trailers?: Readonly<Record<string, string>>;
}

export type SettleFromPatchResult =
    | SettleResult
    | { ok: false; error: 'patch_rejected'; reason: string };

export async function settleFromPatch(
    workdir: Workdir,
    input: SettleFromPatchInput,
): Promise<SettleFromPatchResult> {
    return workdir.lock(async () => {
        const root = workdir.workingTreeRoot;

        // Step 1 — verify the ephemeral workdir's HEAD matches what the
        // patch was generated against. If not, fail fast and let the CLI
        // rebase on the laptop. We never attempt to merge server-side.
        const headSha = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
        if (headSha !== input.parentSha.trim()) {
            return {
                ok: false,
                error: 'fast_forward_required',
                currentSha: headSha,
            };
        }

        if (!input.patch || input.patch.trim().length === 0) {
            return {
                ok: false,
                error: 'patch_rejected',
                reason: 'empty_patch',
            };
        }

        // Step 2 — write the patch to a temp file and `git apply --index`.
        // We do NOT use --3way: any conflict means the patch is stale and
        // the dev must rebase locally. Server-side merge would silently
        // drop the dev's authorship of the conflict resolution.
        const patchPath = join(
            tmpdir(),
            `ernesto-patch-${Date.now()}-${randomBytes(6).toString('hex')}.diff`,
        );
        await writeFile(patchPath, input.patch, 'utf8');

        let applyOk = false;
        let applyErr = '';
        try {
            // Restore tracked files in each touched workspace to HEAD before
            // applying the patch. Reason: server-side workdirs run
            // `ensureMasterFsOverlays` at boot, which hard-links the master-fs
            // version of `WORKSPACE.md` (with derive-worker-injected
            // auto-blocks) over the git-checked-out file. The laptop's
            // patch is generated against the *git* HEAD blob (the laptop has
            // no master-fs overlay), so `apply --index` would reject the
            // pre-image as not matching the on-disk content.
            //
            // `git checkout HEAD -- <path>` rewrites the file from the
            // committed blob — breaking the hard link (new inode), giving us
            // the same byte sequence the laptop authored against.
            // Generated subtrees (`extracted/`, `attached/`) are skipped: the
            // laptop's patch never touches those (`:(exclude)` pathspecs in
            // the CLI's settle), and they aren't tracked in git anyway.
            const checkoutArgs = ['checkout', 'HEAD', '--'];
            for (const ws of input.workspaces) {
                checkoutArgs.push(`workspaces/${ws}`);
                checkoutArgs.push(`:(exclude)workspaces/${ws}/extracted`);
                checkoutArgs.push(`:(exclude)workspaces/${ws}/attached`);
            }
            try { await runGit(root, checkoutArgs); }
            catch { /* fall through; apply will surface the real error */ }

            // Refresh the index's stat cache so `apply --index` can tell
            // "stat-dirty" from "content-dirty" (defense-in-depth; the
            // checkout above writes fresh stat too).
            try { await runGit(root, ['update-index', '--refresh']); }
            catch { /* harmless — partial refresh still helps */ }

            await runGit(root, ['apply', '--check', '--index', '--whitespace=nowarn', patchPath]);
            await runGit(root, ['apply', '--index', '--whitespace=nowarn', patchPath]);
            applyOk = true;
        } catch (err: any) {
            applyErr = String(err?.stderr ?? err?.message ?? 'unknown apply error');
        } finally {
            try { await unlink(patchPath); } catch { /* ignore */ }
        }

        if (!applyOk) {
            // Make sure we leave a clean tree: any partial apply gets reset
            // so the next request against this ephemeral workdir starts
            // fresh. The ephemeral lifetime is per-request, but defense in
            // depth.
            try { await runGit(root, ['reset', '--hard', 'HEAD']); } catch { /* ignore */ }
            return {
                ok: false,
                error: 'patch_rejected',
                reason: applyErr.slice(0, 4000),
            };
        }

        // Step 3 — lint. Same shape as settleFromWorktree: stage is already
        // populated by `git apply --index`; ask git for the cached diff
        // scoped to the declared workspaces and hand it to the lint fn.
        // Diff scoped to the declared workspaces, nesting-/relocation-aware:
        // the patch is already applied to the index, so the tree reflects any
        // relocation. Resolve each declared leaf to its CURRENT location and
        // include BOTH the conventional and resolved paths, so a rename is
        // paired and a nested workspace's changes aren't silently excluded from
        // the lint diff (which would let them bypass the gate).
        const boundaries = await scanWorkspaceBoundaries(root);
        const wsPaths = new Set<string>();
        for (const w of input.workspaces) {
            wsPaths.add(`workspaces/${w}`);
            const resolved = boundaryForName(boundaries, w)?.dir;
            if (resolved) wsPaths.add(resolved);
        }
        const diff = await runGit(root, [
            'diff', '--cached', '--', ...wsPaths,
        ]);

        const lintRes = await input.lint({
            diff,
            workspaces: input.workspaces,
            workingTreeRoot: root,
        });
        if (!lintRes.ok) {
            await runGit(root, ['reset', '--hard', 'HEAD']);
            return {
                ok: false,
                error: 'lint_failed',
                errors: lintRes.errors as ReadonlyArray<LintError>,
            };
        }

        // Step 4 — commit. Same trailer convention as settleFromWorktree;
        // the caller sets `Tier: C` and `User: …` in trailers.
        const commitMessage = formatCommitMessage(input.message, input.trailers);
        await runGit(root, ['commit', '-m', commitMessage]);
        const sha = (await runGit(root, ['rev-parse', 'HEAD'])).trim();

        if (!input.pushToMain) {
            return { ok: true, sha, pushed: false };
        }

        // Step 5 — bot push. Same code path as Tier A; the bot is the only
        // credential allowed to write `main`. If a concurrent settle has
        // already landed, the deployer's push returns fast_forward_required
        // — we bubble that up; the CLI rebases on the laptop and retries.
        const push = await input.pushToMain({
            branchRef: workdir.branchRef,
            sha,
            message: input.message,
        });
        if (!push.ok) return push;

        // Step 6 — sync the ephemeral workdir to the new main. This isn't
        // strictly required for correctness (the workdir is discarded) but
        // it keeps the ephemeral pool reusable if a deployer ever wants a
        // long-lived server-side worktree for Tier C settles.
        try {
            await runGit(root, ['fetch', '--quiet', 'origin', 'main']);
            await runGit(root, ['reset', '--hard', 'FETCH_HEAD']);
        } catch {
            // Recoverable — commit already landed on main.
        }

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
