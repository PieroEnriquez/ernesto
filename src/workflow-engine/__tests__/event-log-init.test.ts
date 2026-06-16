/**
 * Tests for `eventLogInitMiddleware` — the durable claim hook that
 * complements `idempotencyDedupMiddleware`'s in-process Map.
 *
 * The middleware calls the backend-supplied `claim` hook with the
 * runId + kind + principal + inputs + idempotencyKey, expecting an
 * atomic dedup at the durable layer. The lib tests simulate that
 * layer with an in-memory Map keyed by idempotencyKey.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRunner } from '../runner';
import { userPrincipal } from '../principal';
import { eventLogInitMiddleware } from '../middleware/event-log-init';
import { idempotencyDedupMiddleware, IdempotencyConflictError } from '../middleware/idempotency-dedup';
import type { WorkflowReader, WorkflowDetail } from '../workflow-reader';
import type { WorkflowDeclaration, WorkflowStep } from '../../workflows/types';
import type { ClaimRunInput, ClaimRunResult } from '../middleware/event-log-init';

function readerOf(decl: WorkflowDeclaration): WorkflowReader {
    const detail: WorkflowDetail = {
        name: decl.name,
        path: 'mem://w',
        sha: 'sha',
        source: 'mem',
        declaration: decl,
    };
    return {
        async list() {
            return [{ name: decl.name, path: 'mem://w', sha: 'sha' }];
        },
        async read(name: string) {
            return name === decl.name ? detail : undefined;
        },
    };
}

const DECL: WorkflowDeclaration = {
    name: 'wf',
    description: 'd',
    version: 1,
    steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
};

/** In-memory simulation of the backend's durable claim store. Maps
 *  `idempotencyKey → runId` for non-terminal runs. Models the
 *  atomicity the real Mongo partial-unique-index gives. */
function makeClaimStore(): {
    claim: (input: ClaimRunInput) => Promise<ClaimRunResult>;
    release: (key: string) => void;
    inflight: () => Map<string, string>;
} {
    const inflight = new Map<string, string>();
    return {
        async claim(input) {
            if (!input.idempotencyKey) return { ok: true };
            const existing = inflight.get(input.idempotencyKey);
            if (existing && existing !== input.runId) {
                return { ok: false, conflictsWith: existing };
            }
            inflight.set(input.idempotencyKey, input.runId);
            return { ok: true };
        },
        release(key) {
            inflight.delete(key);
        },
        inflight: () => inflight,
    };
}

describe('eventLogInitMiddleware', () => {
    it('is a no-op when no claim hook is supplied', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: { ok: true },
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL);
        runner.use(eventLogInitMiddleware()); // no claim

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
    });

    it('calls the claim hook with the runId + principal + inputs', async () => {
        const runner = createRunner();
        const claim = vi.fn(async (_input: ClaimRunInput): Promise<ClaimRunResult> => ({ ok: true }));
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL);
        runner.use(eventLogInitMiddleware({ claim }));

        await runner.dispatch('wf', { foo: 1 }, userPrincipal('alice', ['x']), {});
        expect(claim).toHaveBeenCalledTimes(1);
        const arg = claim.mock.calls[0]![0]!;
        expect(arg.kind).toBe('wf');
        expect(arg.inputs).toEqual({ foo: 1 });
        expect(arg.principal.kind).toBe('user');
        if (arg.principal.kind === 'user') {
            expect(arg.principal.userId).toBe('alice');
        }
        expect(typeof arg.runId).toBe('string');
    });

    it('threads idempotencyKey from idempotencyDedupMiddleware annotations', async () => {
        const runner = createRunner();
        const claim = vi.fn(async (_input: ClaimRunInput): Promise<ClaimRunResult> => ({ ok: true }));
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.productId }}', scope: 'per-key' },
        });
        runner.use(idempotencyDedupMiddleware());
        runner.use(eventLogInitMiddleware({ claim }));

        await runner.dispatch('wf', { productId: 'sku-123' }, userPrincipal('u', []), {});
        const arg = claim.mock.calls[0]![0]!;
        expect(arg.idempotencyKey).toBe('sku-123');
    });

    it('throws IdempotencyConflictError when claim returns conflict', async () => {
        const runner = createRunner();
        const store = makeClaimStore();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.productId }}', scope: 'per-key' },
        });
        runner.use(idempotencyDedupMiddleware());
        runner.use(eventLogInitMiddleware({ claim: store.claim }));

        // First dispatch: claim succeeds.
        await runner.dispatch('wf', { productId: 'sku-123' }, userPrincipal('u', []), {});

        // Simulate a SECOND process: the in-process map sees the prior
        // run released (after-hook fired) but the durable store still
        // shows the key as claimed.
        // To exercise the durable conflict, simulate the claim still
        // holding by leaving the store entry in place. (We use a fresh
        // runner so the in-process Map starts empty.)
        const runner2 = createRunner();
        runner2.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner2.registerWorkflowReader(readerOf(DECL));
        runner2.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.productId }}', scope: 'per-key' },
        });
        runner2.use(idempotencyDedupMiddleware());
        runner2.use(eventLogInitMiddleware({ claim: store.claim }));

        await expect(runner2.dispatch('wf', { productId: 'sku-123' }, userPrincipal('u', []), {})).rejects.toBeInstanceOf(
            IdempotencyConflictError,
        );
    });

    it('releases the claim so subsequent dispatches with the same key proceed', async () => {
        const runner = createRunner();
        const store = makeClaimStore();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.productId }}', scope: 'per-key' },
        });
        runner.use(idempotencyDedupMiddleware());
        runner.use(eventLogInitMiddleware({ claim: store.claim }));

        await runner.dispatch('wf', { productId: 'sku-x' }, userPrincipal('u', []), {});
        // The in-process map's after-hook released its entry. The
        // durable store still holds the key — but the simulated store
        // is allowed to be released by an explicit `release` (mirrors
        // the Mongo case where the partial-unique constraint only
        // applies to non-terminal status, so completing the row frees
        // the key).
        store.release('sku-x');

        // Second dispatch with same key — now free in both layers.
        const r2 = await runner.dispatch('wf', { productId: 'sku-x' }, userPrincipal('u', []), {});
        expect(r2.status).toBe('completed');
    });

    it('allows same-process dispatch to override its own claim (same runId)', async () => {
        // Edge case: a single dispatch may call claim more than once
        // (retry attempt internal to the runner). The store treats a
        // claim with the same runId as idempotent.
        const runner = createRunner();
        const store = makeClaimStore();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.x }}', scope: 'per-key' },
        });
        runner.use(idempotencyDedupMiddleware());
        runner.use(eventLogInitMiddleware({ claim: store.claim }));

        const run = await runner.dispatch('wf', { x: 'y' }, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
        // Single claim observed.
        expect(store.inflight().size).toBe(1);
    });
});
