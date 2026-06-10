/**
 * `eventLogInitMiddleware` — durable claim of the run row before walk
 * starts. The cross-process counterpart to the in-process
 * `idempotencyDedupMiddleware`.
 *
 * Flow:
 *   1. `idempotencyDedupMiddleware` (registered earlier in the chain)
 *      does the fast in-process Map check. Same-process race: bail
 *      here without touching the store.
 *   2. `eventLogInitMiddleware` calls the backend-supplied `claim`
 *      hook with `{ runId, kind, principal, inputs, idempotencyKey }`.
 *      The backend implements this against its durable store —
 *      atomically insert a row keyed by `idempotencyKey` (when set),
 *      returning the existing runId on collision.
 *   3. On conflict the middleware throws `IdempotencyConflictError`
 *      (same error type idempotencyDedupMiddleware uses, so caller
 *      handling is uniform).
 *   4. On success, the walker proceeds and writes its own
 *      `putRunState({status: 'running'})` updates on top of the
 *      pre-existing claim row.
 *
 * The `idempotencyKey` is read from `ctx.annotations.__idempotencyKey`
 * (where `idempotencyDedupMiddleware` stashes it). If absent, the
 * middleware still calls `claim` so the backend can pre-create the
 * run row — but no uniqueness constraint applies and no conflict can
 * arise. This unifies "always initialize the durable log" with
 * "atomically dedup when the kind opts in."
 *
 * Backend wires:
 *
 *   runner.use(eventLogInitMiddleware({
 *       claim: backendStore.claimRun.bind(backendStore),
 *   }));
 *
 * No-op when `claim` isn't supplied — production wiring is opt-in.
 * Lets the lib's unit tests skip the durable layer.
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';
import type { Principal } from '../principal';
import type { KindRef } from '../types/runner';
import { IdempotencyConflictError } from './idempotency-dedup';

export interface ClaimRunInput {
    runId: string;
    kind: KindRef;
    principal: Principal;
    inputs: Record<string, unknown>;
    /** The idempotency expression resolved against inputs (+ principal
     *  scope suffix) — set by `idempotencyDedupMiddleware`. Absent
     *  when the kind has no `policy.idempotent` declaration. */
    idempotencyKey?: string;
}

/** Backend-supplied durable claim. Atomic — implementations are
 *  expected to use a unique index on `idempotencyKey` (or equivalent)
 *  so concurrent claims collide deterministically. */
export type ClaimRunResult = { ok: true } | { ok: false; conflictsWith: string };

export interface EventLogInitMiddlewareOpts {
    claim?: (input: ClaimRunInput) => Promise<ClaimRunResult>;
    /** Annotation key idempotencyDedupMiddleware uses to stash the
     *  resolved key. Override to align with a custom idempotency
     *  middleware. */
    idempotencyAnnotationKey?: string;
}

export function eventLogInitMiddleware(opts: EventLogInitMiddlewareOpts = {}): DispatchMiddleware {
    const idempotencyAnnotationKey = opts.idempotencyAnnotationKey ?? '__idempotencyKey';

    return {
        name: 'event-log-init',
        async before(ctx: DispatchPreContext): Promise<DispatchPreContext> {
            // No claim hook → no durable layer. The middleware
            // becomes inert (lets unit tests + in-memory deployments
            // skip the work).
            if (!opts.claim) return ctx;

            const idempotencyKey =
                typeof ctx.annotations[idempotencyAnnotationKey] === 'string'
                    ? (ctx.annotations[idempotencyAnnotationKey] as string)
                    : undefined;

            const input: ClaimRunInput = {
                runId: ctx.runId,
                kind: ctx.kind,
                principal: ctx.principal,
                inputs: ctx.inputs,
                ...(idempotencyKey ? { idempotencyKey } : {}),
            };

            const result = await opts.claim(input);
            if (!result.ok) {
                // The backend reports who already holds the claim;
                // surface it via the same error idempotencyDedup uses
                // so call-site catch handlers are uniform.
                throw new IdempotencyConflictError(idempotencyKey ?? `<run:${ctx.runId}>`, result.conflictsWith);
            }
            return ctx;
        },
    };
}
