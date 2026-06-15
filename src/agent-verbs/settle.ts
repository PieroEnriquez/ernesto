/**
 * `settle` agent verb.
 *
 * The agent-facing wrapper around `settleFromWorktree`. Spec §8 / §30.
 *
 * The verb's input is `{ message, files }`. `files` is the agent's BY-REFERENCE
 * selection — the tree-relative paths it wants to publish — and is REQUIRED and
 * non-empty: a settle with no selection is REFUSED (`selection_required`), never
 * a silent whole-draft publish. The `workspaces[]` are DERIVED from the selected
 * `files` so the agent never has to enumerate them, and the settle scope can
 * never widen past what the agent chose. A deliberate whole-draft publish is the
 * `['*']` sentinel, normalized to "all in scope" by the calling adapter BEFORE
 * this verb (so the verb itself only ever sees literal paths).
 *
 * Side-effects (audit log + pubsub) are NOT performed here — they're
 * injected as `hooks` by the deployer. Hook failures are caught and logged
 * (warn) without altering the settle result.
 */

import { z } from 'zod';
import type { Workdir, LintFn, PushToMainFn, SettleResult, LintError } from '../workdir';
import { settleFromWorktree, runGit } from '../workdir';
import { GENERATED_SUBDIRS, GENERATED_FILES } from '../workdir/settle-core';
import { scanWorkspaceBoundaries, boundaryForPath, type WorkspaceBoundary } from '../workspaces/boundaries';
import type { VerbLogger, VerbUser } from './types';

export const settleInputSchema = z.object({
    message: z.string().min(1).max(500),
    /** By-reference selection of draft paths to publish (tree-relative POSIX,
     *  `workspaces/<w>/…`). REQUIRED and non-empty — an unselected settle is
     *  refused. The `workspaces[]` access boundary is derived from these paths. */
    files: z.array(z.string().min(1)).min(1),
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
      }
    /** The selection narrowed (or, for an empty file set, an upstream caller
     *  derived) to nothing in scope: no draft path matched the agent's `files`.
     *  `draft` lists the caller's actual in-scope draft paths so the agent can
     *  re-select in one turn. Distinct from `invalid_input` (a malformed
     *  request) — here the request was well-formed but selected nothing. */
    | {
          ok: false;
          error: 'selection_required';
          message: string;
          draft: ReadonlyArray<string>;
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
    z.object({
        ok: z.literal(false),
        error: z.literal('selection_required'),
        message: z.string(),
        draft: z.array(z.string()),
    }),
]);

export const SETTLE_DESCRIPTION = `Commit and push a SELECTED set of your draft files to main. You MUST choose which files to publish — settle never publishes your whole draft implicitly. The lint runs first (will reject if any workspace's frontmatter changes violate scopes, if attachments.yaml is structurally invalid (\`invalid_attachments_yaml\`), if a file is not UTF-8 text (\`binary_file\`), or if merge markers leaked through, etc.). On success, the selected files land on \`main\` of the workspaces monorepo via a fast-forward bot push.

Input: \`{ message: string, files: string[] }\`
- \`message\` — short commit message (1-500 chars).
- \`files\` — REQUIRED, non-empty. The tree-relative paths to publish (e.g. \`workspaces/hr/handbook.md\`), chosen from your current draft. Only these land; the rest of your draft stays uncommitted for a later settle. To publish your ENTIRE in-scope draft, pass the single sentinel \`files: ['*']\` (a deliberate, audited whole-draft publish) — do not mix \`*\` with literal paths.

Output: \`{ ok: true, sha, pushed, ... }\` on success; \`{ ok: false, error, ... }\` otherwise. If \`files\` is missing/empty you get \`selection_required\` with the list of your current draft paths — re-call with the subset you want. If lint fails, fix the cited rule violations and call settle again.

Call this exactly once when your selected work in this turn is complete. Do not call it speculatively.`;

export type SettleVerbLogger = VerbLogger;

export interface SettleVerbHooks {
    /** Called after a successful settle (commit + push). Used by the
     *  in-process transport's host to record an audit log entry +
     *  publish a workspaces.pushed pubsub. */
    onSettleSuccess?: (workspaces: ReadonlyArray<string>, sha: string, pushed: boolean) => Promise<void>;
    /** Called after a failed settle. Used by backend to record audit log entry. */
    onSettleFailure?: (workspaces: ReadonlyArray<string>, error: string, errors?: ReadonlyArray<LintError>) => Promise<void>;
}

export interface SettleVerbContext {
    user: VerbUser;
    scopes: ReadonlySet<string>;
    lint: LintFn;
    pushToMain: PushToMainFn;
    log: SettleVerbLogger;
    /** Optional trailers added to the commit message (e.g. Workdir-Id, User, Transport). */
    trailers?: Readonly<Record<string, string>>;
    hooks?: SettleVerbHooks;
}

/**
 * Handle one `settle` call.
 *
 * 1. Validate `message` (size guard).
 * 2. REQUIRE a non-empty `files` selection. Absent/empty ⇒ `selection_required`
 *    (with the caller's current draft paths so the agent can re-select).
 * 3. DERIVE the affected workspaces from the SELECTED `files` (never the whole
 *    working tree): the agent's selection is the access boundary, so a settle
 *    can never widen past the files it chose.
 * 4. Delegate to `settleFromWorktree`.
 * 5. Fire `onSettleSuccess` or `onSettleFailure` hooks; swallow their errors.
 */
export async function handleSettle(workdir: Workdir, input: SettleInput, ctx: SettleVerbContext): Promise<SettleVerbResult> {
    // Validate `message` independently of `files` so an absent/empty selection
    // surfaces as the guiding `selection_required` refusal (with the draft list)
    // rather than a generic `invalid_input`.
    const messageParsed = z.object({ message: z.string().min(1).max(500) }).safeParse(input);
    if (!messageParsed.success) {
        return {
            ok: false,
            error: 'invalid_input',
            details: { issues: messageParsed.error.issues },
        };
    }

    const filesRaw = (input as { files?: unknown }).files;
    const filesValid = Array.isArray(filesRaw) && filesRaw.length > 0 && filesRaw.every((f) => typeof f === 'string' && f.length > 0);
    if (!filesValid) {
        // No selection ⇒ REFUSE (never the old whole-draft publish). List the
        // caller's current draft paths so the agent can re-select in one turn.
        const draft = await deriveDraftPaths(workdir.workingTreeRoot);
        ctx.log.warn('settle verb: selection required', { userId: ctx.user.id, draftCount: draft.length });
        return {
            ok: false,
            error: 'selection_required',
            message:
                'settle now requires you to choose which files to publish. ' +
                `Your draft has: ${draft.join(', ') || '(none)'}. ` +
                "Pass files:[…] with the subset to publish, or files:['*'] to publish all.",
            draft,
        };
    }
    const files = filesRaw as string[];

    ctx.log.info('settle verb', {
        userId: ctx.user.id,
        message: messageParsed.data.message.substring(0, 80),
        fileCount: files.length,
    });

    // The access boundary is DERIVED from the selected files, not the whole
    // working tree: a settle can never reach a workspace the agent did not
    // select a path in.
    const workspaces = await deriveWorkspacesFromFiles(files, workdir.workingTreeRoot);

    if (workspaces.length === 0) {
        // Every selected path was outside `workspaces/<name>/…` (or a master-fs
        // overlay) — nothing settleable. Refuse with the draft list, same shape
        // as an empty selection.
        const draft = await deriveDraftPaths(workdir.workingTreeRoot);
        ctx.log.warn('settle verb: selection matched no workspace path', { userId: ctx.user.id });
        return {
            ok: false,
            error: 'selection_required',
            message:
                'None of the selected files resolve under workspaces/<name>/. ' +
                `Your draft has: ${draft.join(', ') || '(none)'}. ` +
                "Pass files:[…] with workspace-relative paths, or files:['*'] to publish all.",
            draft,
        };
    }

    const pushToMain = wrapPushWithFastForwardRetry(workdir, ctx.pushToMain, ctx.log);

    const result = await settleFromWorktree(workdir, {
        workspaces,
        message: messageParsed.data.message,
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
function wrapPushWithFastForwardRetry(workdir: Workdir, pushToMain: PushToMainFn, log: VerbLogger): PushToMainFn {
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
 * Resolve a `workspaces/<name>/<rest>` tree path to its OWNING workspace leaf,
 * skipping master-fs overlays + transient archives + the `.derived-from-sha`
 * marker.
 *
 * `extracted/`, `attached/`, `_results/` subdirs (the GeneratedStore mirrors +
 * per-conversation route-result archives the `execute` verb writes) and the
 * `routes/` definitions are never author intent, so they never pull a workspace
 * into the settle set. The constants are single-sourced from `settleFromWorktree`'s
 * GENERATED_SUBDIRS + GENERATED_FILES (plus the literal `routes`) — the
 * staging-side companion filter. `attachments.yaml` is deliberately NOT skipped:
 * it's a tracked, draftable file whose pending edits settle like prose.
 *
 * Resolution is nesting-aware: a path inside a nested workspace
 * (`workspaces/hr/recruiting/…`) derives `recruiting` (the leaf the lint scopes
 * against) via `boundaryForPath`, not `hr`. A path with no boundary at all falls
 * back to its first segment.
 *
 * Returns `null` for a non-workspace path or a generated/master-fs overlay.
 */
function workspaceLeafOf(treePath: string, boundaries: readonly WorkspaceBoundary[]): string | null {
    if (!treePath.startsWith('workspaces/')) return null;
    const segs = treePath.slice('workspaces/'.length).split('/');
    if (segs.length < 2) return null; // a file directly under workspaces/ belongs to no workspace
    const dirSegs = segs.slice(0, -1);
    const basename = segs[segs.length - 1];
    if (dirSegs.some((s) => (GENERATED_SUBDIRS as readonly string[]).includes(s) || s === 'routes')) return null;
    if ((GENERATED_FILES as readonly string[]).includes(basename)) return null;
    return boundaryForPath(boundaries, treePath)?.name ?? segs[0];
}

/**
 * Derive the workspace leaf names the SELECTED `files` resolve under. The agent's
 * selection — not the whole working tree — is the access boundary, so settle can
 * never widen past a workspace the agent named a path in. Deduped + sorted for
 * deterministic downstream behaviour (audit ordering, etc.). Selected paths that
 * are non-workspace or master-fs/generated overlays contribute no workspace.
 *
 * Nesting-aware: scans the working tree's workspace boundaries once so a selected
 * path inside a nested workspace resolves to its leaf, not the parent.
 */
async function deriveWorkspacesFromFiles(files: ReadonlyArray<string>, workingTreeRoot: string): Promise<string[]> {
    const boundaries = await scanWorkspaceBoundaries(workingTreeRoot);
    const names = new Set<string>();
    for (const f of files) {
        const leaf = workspaceLeafOf(f, boundaries);
        if (leaf) names.add(leaf);
    }
    return [...names].sort();
}

/**
 * Enumerate the caller's current draft paths in the working tree, scoped to
 * `workspaces/<name>/…` and minus master-fs/generated overlays (but INCLUDING a
 * pending `attachments.yaml`, which is now a draftable file). Used only to
 * populate the `selection_required` guidance so the agent can re-select.
 *
 * Uses `git status --porcelain -uall` so both staged/unstaged and untracked
 * files count. Deduped + sorted.
 */
async function deriveDraftPaths(workingTreeRoot: string): Promise<string[]> {
    const out = await runGit(workingTreeRoot, ['status', '--porcelain', '-uall']);
    const boundaries = await scanWorkspaceBoundaries(workingTreeRoot);
    const paths = new Set<string>();
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
        if (workspaceLeafOf(path, boundaries)) paths.add(path);
    }
    return [...paths].sort();
}
