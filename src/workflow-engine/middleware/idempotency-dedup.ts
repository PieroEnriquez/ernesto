/**
 * `idempotencyDedupMiddleware` — in-process dedup of concurrent
 * dispatches keyed by `kind.policy.idempotent.key`.
 *
 * Reads the kind's declared idempotency key expression (same `${{ }}`
 * grammar the orchestration handler uses against inputs + principal),
 * resolves it against the dispatch's inputs, and rejects a second
 * dispatch with the same key while one is in flight.
 *
 * Scope:
 *   - `per-key`: any caller's repeat dispatch is rejected
 *   - `per-key-and-principal`: only the same principal's repeats are
 *     rejected — different users with the same key proceed
 *
 * Limitation: this is in-process only. Cross-process dedup
 * (e.g., autofill running on two backend pods racing the same product)
 * requires M3's durable event log. The contract is the same — once
 * M3 lands, swap the in-process Map for a store query, no caller
 * changes needed.
 *
 * Useful today for:
 *   - Slack subscriber dropping duplicate event deliveries (key =
 *     slackEventId)
 *   - Cron scheduler dropping double-fired ticks (key =
 *     `cron-${jobId}-${tickEpoch}`)
 *   - Backend workers deduping within a single pod
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';

export class IdempotencyConflictError extends Error {
    readonly code = 'idempotency_conflict';
    readonly key: string;
    readonly inflightRunId?: string;
    constructor(key: string, inflightRunId?: string) {
        const detail = inflightRunId ? ` (in-flight runId: ${inflightRunId})` : '';
        super(`dispatch rejected — idempotency key "${key}" already in flight${detail}`);
        this.name = 'IdempotencyConflictError';
        this.key = key;
        if (inflightRunId !== undefined) this.inflightRunId = inflightRunId;
    }
}

export interface IdempotencyDedupOpts {
    /** Per-dispatch annotation key the middleware uses to stash the
     *  resolved idempotency key for the `after` hook. Override only
     *  if you have a name collision (unlikely). */
    annotationKey?: string;
}

export function idempotencyDedupMiddleware(opts: IdempotencyDedupOpts = {}): DispatchMiddleware {
    const annotationKey = opts.annotationKey ?? '__idempotencyKey';
    /** Map<resolvedKey, runId> of in-flight dispatches. */
    const inflight = new Map<string, string>();

    return {
        name: 'idempotency-dedup',
        before(ctx: DispatchPreContext): DispatchPreContext {
            const policy = ctx.decl?.policy?.idempotent;
            if (!policy?.key) return ctx;

            const resolvedKey = resolveIdempotencyKey(
                policy.key,
                ctx.inputs,
                policy.scope === 'per-key-and-principal'
                    ? ctx.principal.kind === 'user'
                        ? `user:${ctx.principal.userId}`
                        : `service:${ctx.principal.workerId}`
                    : undefined,
            );
            if (!resolvedKey) {
                // Empty / unresolvable key — proceed without dedup.
                return ctx;
            }

            const existing = inflight.get(resolvedKey);
            if (existing !== undefined) {
                throw new IdempotencyConflictError(resolvedKey, existing);
            }

            // Stash the key for the after-hook + record in-flight.
            // We don't know the runId yet (the runner mints it after
            // middleware runs); store the key on annotations so the
            // after-hook can clean up.
            ctx.annotations[annotationKey] = resolvedKey;
            inflight.set(resolvedKey, '<pending>'); // placeholder
            return ctx;
        },
        after(ctx: DispatchPreContext, run): void {
            const resolvedKey = ctx.annotations[annotationKey] as string | undefined;
            if (resolvedKey === undefined) return;
            // Best-effort: surface the runId now that we have it,
            // before deleting. Race-free because before/after run
            // synchronously around the walk.
            inflight.set(resolvedKey, run.runId);
            inflight.delete(resolvedKey);
        },
    };
}

/** Resolve the idempotency-key expression. Supports a literal
 *  `inputs.X` path OR a `${{ inputs.X }}` wrapped token. Concatenates
 *  with the principal-scope suffix when provided. */
function resolveIdempotencyKey(expr: string, inputs: Record<string, unknown>, principalScopeSuffix?: string): string | undefined {
    // Strip ${{ }} if present.
    const m = /^\$\{\{\s*([^}]+?)\s*\}\}$/.exec(expr.trim());
    const inner = (m ? m[1]! : expr).trim();
    const parts = inner
        .split('.')
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length < 2 || parts[0] !== 'inputs') return undefined;

    let cur: unknown = inputs;
    for (const p of parts.slice(1)) {
        if (cur === null || cur === undefined) return undefined;
        if (typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    if (cur === undefined || cur === null) return undefined;
    const base = typeof cur === 'string' ? cur : JSON.stringify(cur);
    return principalScopeSuffix ? `${base}::${principalScopeSuffix}` : base;
}
