/**
 * `settle` agent verb.
 *
 * The agent-facing wrapper around `settleFromWorktree`. Spec §8 / §30.
 *
 * The verb's input is `{ message }` — workspaces are derived from the
 * working-tree diff vs `origin/main` so the agent never has to enumerate
 * them. The host application's settle endpoint stays the source of truth
 * for explicit `workspaces[]` (the laptop transport ships a patch, where
 * the set is known up-front); the in-process verbs let the lib infer.
 *
 * Side-effects (audit log + pubsub) are NOT performed here — they're
 * injected as `hooks` by the deployer. Hook failures are caught and logged
 * (warn) without altering the settle result.
 */

import { z } from 'zod';
import type { Workdir, LintFn, PushToMainFn, SettleResult, LintError } from '../workdir';
import { settleFromWorktree, runGit } from '../workdir';
import type { VerbLogger, VerbUser } from './types';

export const settleInputSchema = z.object({
    message: z.string().min(1).max(500),
});
export type SettleInput = z.infer<typeof settleInputSchema>;

/**
 * `settle`-verb result. Identical to the lib's `SettleResult` plus one extra
 * variant for verb-boundary input validation. The extra variant lets the lib
 * keep `SettleResult` pure (it never returns `invalid_input` itself) while
 * still giving the verb a single discriminated union to expose.
 */
export type SettleVerbResult =
    | SettleResult
    | {
          ok: false;
          error: 'invalid_input';
          details: { issues: ReadonlyArray<unknown> };
      };

export const settleOutputSchema = z.discriminatedUnion('ok', [
    z.object({
        ok: z.literal(true),
        sha: z.string(),
        pushed: z.boolean(),
    }),
    z.object({
        ok: z.literal(false),
        error: z.literal('lint_failed'),
        errors: z.array(
            z.object({
                code: z.string(),
                workspace: z.string().optional(),
                path: z.string().optional(),
                message: z.string(),
            }),
        ),
    }),
    z.object({
        ok: z.literal(false),
        error: z.literal('fast_forward_required'),
        currentSha: z.string(),
    }),
    z.object({
        ok: z.literal(false),
        error: z.literal('merge_conflict'),
    }),
    z.object({
        ok: z.literal(false),
        error: z.literal('invalid_input'),
        details: z.object({ issues: z.array(z.unknown()) }),
    }),
]);

export const SETTLE_DESCRIPTION = `Commit and push the current working-tree changes to main. The lint runs first (will reject if any workspace's frontmatter changes violate scopes, or if attachments.yaml is hand-edited, or if merge markers leaked through, etc.). On success, files land on \`main\` of the workspaces monorepo via a fast-forward bot push.

Input: \`{ message: string }\` — short commit message (1-500 chars).

Output: \`{ ok: true, sha, pushed, ... }\` on success; \`{ ok: false, error, ... }\` on lint failure or push failure. If lint fails, fix the cited rule violations and call settle again.

Call this exactly once when your work in this turn is complete and you have no further file changes to make. Do not call it speculatively.`;

export type SettleVerbLogger = VerbLogger;

export interface SettleVerbHooks {
    /** Called after a successful settle (commit + push). Used by the
     *  in-process transport's host to record an audit log entry +
     *  publish a workspaces.pushed pubsub. */
    onSettleSuccess?: (
        workspaces: ReadonlyArray<string>,
        sha: string,
        pushed: boolean,
    ) => Promise<void>;
    /** Called after a failed settle. Used by backend to record audit log entry. */
    onSettleFailure?: (
        workspaces: ReadonlyArray<string>,
        error: string,
        errors?: ReadonlyArray<LintError>,
    ) => Promise<void>;
}

export interface SettleVerbContext {
    user: VerbUser;
    scopes: ReadonlySet<string>;
    lint: LintFn;
    pushToMain: PushToMainFn;
    log: SettleVerbLogger;
    /** Optional trailers added to the commit message (e.g. Workdir-Id, User, Tier). */
    trailers?: Readonly<Record<string, string>>;
    hooks?: SettleVerbHooks;
}

/**
 * Handle one `settle` call.
 *
 * 1. Validate input (size guard on `message`).
 * 2. Derive affected workspaces from the working-tree diff vs `origin/main`,
 *    plus any untracked files under `workspaces/<name>/`.
 * 3. Delegate to `settleFromWorktree`.
 * 4. Fire `onSettleSuccess` or `onSettleFailure` hooks; swallow their errors.
 */
export async function handleSettle(
    workdir: Workdir,
    input: SettleInput,
    ctx: SettleVerbContext,
): Promise<SettleVerbResult> {
    const parsed = settleInputSchema.safeParse(input);
    if (!parsed.success) {
        return {
            ok: false,
            error: 'invalid_input',
            details: { issues: parsed.error.issues },
        };
    }

    ctx.log.info('settle verb', {
        userId: ctx.user.id,
        message: parsed.data.message.substring(0, 80),
    });

    const workspaces = await deriveAffectedWorkspaces(workdir.workingTreeRoot);

    if (workspaces.length === 0) {
        // No workspace-scoped changes — treat as a lint-style refusal so the
        // agent gets a structured shape it already knows how to handle. The
        // empty `errors` array is honest: no rule was violated, there's just
        // nothing to settle.
        ctx.log.warn('settle verb: nothing to settle', { userId: ctx.user.id });
        const result: SettleResult = {
            ok: false,
            error: 'lint_failed',
            errors: [
                {
                    code: 'nothing_to_settle',
                    message: 'No workspace-scoped changes detected in the working tree.',
                },
            ],
        };
        await fireFailureHook(ctx, [], result.error, result.errors);
        return result;
    }

    const pushToMain = wrapPushWithFastForwardRetry(workdir, ctx.pushToMain, ctx.log);

    const result = await settleFromWorktree(workdir, {
        workspaces,
        message: parsed.data.message,
        lint: ctx.lint,
        pushToMain,
        trailers: ctx.trailers,
    });

    if (result.ok) {
        if (ctx.hooks?.onSettleSuccess) {
            try {
                await ctx.hooks.onSettleSuccess(workspaces, result.sha, result.pushed);
            } catch (err) {
                ctx.log.warn('onSettleSuccess hook failed', {
                    errorMessage: (err as Error).message,
                });
            }
        }
    } else {
        const errors = result.error === 'lint_failed' ? result.errors : undefined;
        await fireFailureHook(ctx, workspaces, result.error, errors);
    }

    return result;
}

async function fireFailureHook(
    ctx: SettleVerbContext,
    workspaces: ReadonlyArray<string>,
    error: string,
    errors?: ReadonlyArray<LintError>,
): Promise<void> {
    if (!ctx.hooks?.onSettleFailure) return;
    try {
        await ctx.hooks.onSettleFailure(workspaces, error, errors);
    } catch (err) {
        ctx.log.warn('onSettleFailure hook failed', {
            errorMessage: (err as Error).message,
        });
    }
}

/**
 * Wrap a `PushToMainFn` with a single-shot fast-forward retry.
 *
 * Race we're closing: the derive worker's startup-sweep can land a commit on
 * `origin/main` between our local commit and our bot push, which makes the
 * push come back as `fast_forward_required`. Without a retry the agent's
 * settle just fails — even though our changes are still cleanly rebaseable
 * (workspace-scoped commits don't conflict across workers in practice).
 *
 * On `fast_forward_required` we:
 *   1. Fetch `origin/main`.
 *   2. Rebase the local single commit (HEAD) onto FETCH_HEAD.
 *   3. Re-read HEAD's sha and retry the push exactly once.
 *
 * If the rebase fails (real conflict) or the second push also rejects, we
 * propagate the second result. No infinite loop.
 *
 * The rebase replays our single local commit on top of the new main — same
 * shape `settleFromWorktree` itself does on the success path (fetch + reset
 * --hard FETCH_HEAD), just on the rejection path and with a `cherry-pick`
 * to preserve our commit instead of dropping it.
 */
function wrapPushWithFastForwardRetry(
    workdir: Workdir,
    pushToMain: PushToMainFn,
    log: VerbLogger,
): PushToMainFn {
    return async (input) => {
        const first = await pushToMain(input);
        if (first.ok || first.error !== 'fast_forward_required') return first;

        log.info('settle verb: bot push rejected as non-fast-forward; rebasing on origin/main and retrying once', {
            workdirId: workdir.workdirId,
            attemptedSha: input.sha,
            currentSha: first.currentSha,
        });

        const root = workdir.workingTreeRoot;
        try {
            await runGit(root, ['fetch', '--quiet', 'origin', 'main']);
            // HEAD is already our single new commit (settleFromWorktree just
            // made it). Rebasing onto FETCH_HEAD replays it on top of the new
            // origin/main; if the rebase conflicts we abort and propagate.
            await runGit(root, ['rebase', 'FETCH_HEAD']);
        } catch (err) {
            // Best-effort cleanup so the workdir isn't left mid-rebase.
            try {
                await runGit(root, ['rebase', '--abort']);
            } catch {
                // ignore
            }
            log.warn('settle verb: rebase on origin/main failed, propagating fast_forward_required', {
                workdirId: workdir.workdirId,
                errorMessage: (err as Error).message,
            });
            return first;
        }

        const newSha = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
        return pushToMain({
            branchRef: input.branchRef,
            sha: newSha,
            message: input.message,
        });
    };
}

/**
 * Enumerate workspaces with pending changes in the working tree.
 *
 * Uses `git status --porcelain -uall` so both staged/unstaged and untracked
 * files under `workspaces/<name>/...` count. The set is deduped + sorted
 * for deterministic downstream behaviour (audit ordering, etc.).
 */
async function deriveAffectedWorkspaces(workingTreeRoot: string): Promise<string[]> {
    const out = await runGit(workingTreeRoot, ['status', '--porcelain', '-uall']);
    const names = new Set<string>();
    for (const line of out.split('\n')) {
        if (line.length === 0) continue;
        // Porcelain v1: "XY path" or "XY orig -> path" for renames.
        // Slice past the two status chars + the space.
        let path = line.slice(3);
        const arrow = path.indexOf(' -> ');
        if (arrow !== -1) path = path.slice(arrow + 4);
        // Strip surrounding quotes git applies to paths with special chars.
        if (path.startsWith('"') && path.endsWith('"')) {
            path = path.slice(1, -1);
        }
        const match = /^workspaces\/([^/]+)\/(.+)$/.exec(path);
        if (match) {
            // Skip master-fs overlays. `extracted/`, `routes/`, `attached/`
            // subdirs AND the `attachments.yaml` file are hard-link mirrors
            // of master-fs placed at session boot (host-owned overlay
            // setup) / mid-session (`remirrorFile`).
            // Without this filter, every workspace whose mirror got
            // refreshed — or that the agent attached a file to via
            // `_platform://attach` — would show up as untracked in
            // `git status` and be added to the "affected" set on every
            // settle, firing audit + pubsub hooks for workspaces the user
            // never edited. The staging-side companion filter lives in
            // `settleFromWorktree`'s GENERATED_SUBDIRS + GENERATED_FILES.
            const rest = match[2];
            const firstSeg = rest.split('/')[0];
            if (rest === 'attachments.yaml') continue;
            if (firstSeg !== 'extracted' && firstSeg !== 'routes' && firstSeg !== 'attached') {
                names.add(match[1]);
            }
        }
    }
    return [...names].sort();
}
