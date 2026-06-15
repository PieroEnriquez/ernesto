/**
 * Laptop-transport settle path — apply a unified diff produced on the dev's
 * laptop into an ephemeral host-side workdir, run lint over the staged result,
 * commit with trailers, hand the resulting sha to the deployer's bot push.
 *
 * Contract:
 *   - The workdir's HEAD must equal `parentSha`. If not, we return
 *     `fast_forward_required` so the laptop can `git pull --rebase`,
 *     regenerate the patch, and retry. We do NOT attempt to rebase
 *     host-side: the dev's working tree is on the laptop, the patch was
 *     authored against the laptop's view of main, and merging host-side
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
 */

import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { Workdir } from './types';
import { runGit } from './run-git';
import { SettleResult, LintFn, PushToMainFn } from './settle';
import { runSettleCore, resolveWorkspaceStagePaths, GENERATED_SUBDIRS } from './settle-core';

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

export type SettleFromPatchResult = SettleResult | { ok: false; error: 'patch_rejected'; reason: string };

export async function settleFromPatch(workdir: Workdir, input: SettleFromPatchInput): Promise<SettleFromPatchResult> {
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
        const patchPath = join(tmpdir(), `ernesto-patch-${Date.now()}-${randomBytes(6).toString('hex')}.diff`);
        await writeFile(patchPath, input.patch, 'utf8');

        let applyOk = false;
        let applyErr = '';
        try {
            // Restore tracked files in each touched workspace to HEAD before
            // applying the patch. Reason: host-side workdirs run
            // `ensureMasterFsOverlays` at boot, which hard-links the master-fs
            // version of `WORKSPACE.md` (with derive-worker-injected
            // auto-blocks) over the git-checked-out file. The laptop's
            // patch is generated against the *git* HEAD blob (the laptop has
            // no master-fs overlay), so `apply --index` would reject the
            // pre-image as not matching the on-disk content.
            //
            // `git checkout HEAD -- <path>` rewrites the file from the
            // committed blob — breaking the hard link (new inode), giving us
            // the same byte sequence the laptop authored against. A tracked
            // `attachments.yaml` restored here is the correct pre-image too:
            // the laptop's patch is authored against the git blob.
            //
            // Workspaces resolve to their CURRENT boundary dirs (a nested
            // `hr/recruiting` lives at `workspaces/hr/recruiting`, not
            // `workspaces/recruiting`) via the same resolution the patch
            // builder uses, so the restore covers exactly what the patch
            // touches. Generated subtrees are skipped: the laptop's patch
            // never carries those (`:(exclude)` pathspecs in the laptop's
            // settle), and they aren't tracked in git anyway.
            try {
                const { stagePaths } = await resolveWorkspaceStagePaths(root, input.workspaces);
                const checkoutArgs = ['checkout', 'HEAD', '--'];
                for (const p of stagePaths) {
                    checkoutArgs.push(p);
                    for (const sub of GENERATED_SUBDIRS) {
                        checkoutArgs.push(`:(exclude)${p}/${sub}`);
                    }
                }
                await runGit(root, checkoutArgs);
            } catch {
                /* fall through; apply will surface the real error */
            }

            // Refresh the index's stat cache so `apply --index` can tell
            // "stat-dirty" from "content-dirty" (defense-in-depth; the
            // checkout above writes fresh stat too).
            try {
                await runGit(root, ['update-index', '--refresh']);
            } catch {
                /* harmless — partial refresh still helps */
            }

            await runGit(root, ['apply', '--check', '--index', '--whitespace=nowarn', patchPath]);
            await runGit(root, ['apply', '--index', '--whitespace=nowarn', patchPath]);
            applyOk = true;
        } catch (err: any) {
            applyErr = String(err?.stderr ?? err?.message ?? 'unknown apply error');
        } finally {
            try {
                await unlink(patchPath);
            } catch {
                /* ignore */
            }
        }

        if (!applyOk) {
            // Make sure we leave a clean tree: any partial apply gets reset
            // so the next request against this ephemeral workdir starts
            // fresh. The ephemeral lifetime is per-request, but defense in
            // depth.
            try {
                await runGit(root, ['reset', '--hard', 'HEAD']);
            } catch {
                /* ignore */
            }
            return {
                ok: false,
                error: 'patch_rejected',
                reason: applyErr.slice(0, 4000),
            };
        }

        // Steps 3–6 — converge on the shared lint → commit → push →
        // journal-rebase tail. The stage is already populated by
        // `git apply --index`; the core scopes the lint diff nesting-aware,
        // commits with the caller's trailers (transport + user), bot-pushes,
        // and rebases the ephemeral workdir onto new main. A lint failure
        // hard-resets the ephemeral tree (it is per-request, not the dev's).
        return runSettleCore(workdir, {
            workspaces: input.workspaces,
            message: input.message,
            lint: input.lint,
            pushToMain: input.pushToMain,
            trailers: input.trailers,
            onLintFail: 'reset-hard',
        });
    });
}
