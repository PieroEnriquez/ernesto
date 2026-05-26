/**
 * Tests for `idempotencyDedupMiddleware` — in-process dedup of
 * concurrent dispatches by idempotency key expression.
 */

import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner';
import { userPrincipal, servicePrincipal } from '../principal';
import {
    idempotencyDedupMiddleware,
    IdempotencyConflictError,
} from '../middleware/idempotency-dedup';
import type { WorkflowReader, WorkflowDetail } from '../workflow-reader';
import type { WorkflowDeclaration, WorkflowStep } from '../../workflows/types';

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
    name: 'wf-idem',
    description: 'd',
    version: 1,
    steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
};

describe('idempotencyDedupMiddleware', () => {
    it('rejects a concurrent dispatch with the same key', async () => {
        const runner = createRunner();
        // Route handler that blocks until released, simulating an
        // in-flight workflow.
        let release: (() => void) | undefined;
        const blocker = new Promise<void>((res) => {
            release = res;
        });
        runner.registerStepKind('route', async () => {
            await blocker;
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.productId }}', scope: 'per-key' },
        });
        runner.use(idempotencyDedupMiddleware());

        // Fire first dispatch (will block).
        const first = runner.dispatch(
            'wf-idem',
            { productId: 'P-1' },
            userPrincipal('alice', []),
            {},
        );
        // Give it a tick to land in the in-flight map.
        await new Promise((r) => setImmediate(r));
        // Second dispatch with same key — should throw immediately.
        await expect(
            runner.dispatch(
                'wf-idem',
                { productId: 'P-1' },
                userPrincipal('bob', []),
                {},
            ),
        ).rejects.toThrow(IdempotencyConflictError);
        // Release and confirm the first completes normally.
        release!();
        const result = await first;
        expect(result.status).toBe('completed');
    });

    it('allows a second dispatch with a different key', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.productId }}', scope: 'per-key' },
        });
        runner.use(idempotencyDedupMiddleware());

        const a = await runner.dispatch(
            'wf-idem',
            { productId: 'P-1' },
            userPrincipal('u', []),
            {},
        );
        const b = await runner.dispatch(
            'wf-idem',
            { productId: 'P-2' },
            userPrincipal('u', []),
            {},
        );
        expect(a.status).toBe('completed');
        expect(b.status).toBe('completed');
    });

    it('clears in-flight on terminal — sequential dispatches with same key both succeed', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.productId }}', scope: 'per-key' },
        });
        runner.use(idempotencyDedupMiddleware());

        const a = await runner.dispatch(
            'wf-idem',
            { productId: 'P-1' },
            userPrincipal('u', []),
            {},
        );
        expect(a.status).toBe('completed');
        // After terminal, key should be released — same key can run again.
        const b = await runner.dispatch(
            'wf-idem',
            { productId: 'P-1' },
            userPrincipal('u', []),
            {},
        );
        expect(b.status).toBe('completed');
    });

    it('scope per-key-and-principal: different users with same key do NOT conflict', async () => {
        const runner = createRunner();
        let release: (() => void) | undefined;
        const blocker = new Promise<void>((res) => {
            release = res;
        });
        runner.registerStepKind('route', async () => {
            await blocker;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: {
                key: '${{ inputs.productId }}',
                scope: 'per-key-and-principal',
            },
        });
        runner.use(idempotencyDedupMiddleware());

        const alice = runner.dispatch(
            'wf-idem',
            { productId: 'P-1' },
            userPrincipal('alice', []),
            {},
        );
        await new Promise((r) => setImmediate(r));
        // Bob with same productId — different principal scope; allowed.
        const bobPromise = runner.dispatch(
            'wf-idem',
            { productId: 'P-1' },
            userPrincipal('bob', []),
            {},
        );
        await new Promise((r) => setImmediate(r));
        release!();
        const aliceResult = await alice;
        const bobResult = await bobPromise;
        expect(aliceResult.status).toBe('completed');
        expect(bobResult.status).toBe('completed');
    });

    it('no policy → no-op', async () => {
        const runner = createRunner();
        let release: (() => void) | undefined;
        const blocker = new Promise<void>((res) => {
            release = res;
        });
        runner.registerStepKind('route', async () => {
            await blocker;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL); // no policy
        runner.use(idempotencyDedupMiddleware());

        const a = runner.dispatch(
            'wf-idem',
            { productId: 'X' },
            userPrincipal('u', []),
            {},
        );
        const b = runner.dispatch(
            'wf-idem',
            { productId: 'X' },
            userPrincipal('u', []),
            {},
        );
        release!();
        const [ra, rb] = await Promise.all([a, b]);
        expect(ra.status).toBe('completed');
        expect(rb.status).toBe('completed');
    });

    it('unresolvable key (path not found in inputs) → proceeds without dedup', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.missing }}', scope: 'per-key' },
        });
        runner.use(idempotencyDedupMiddleware());

        const run = await runner.dispatch(
            'wf-idem',
            { productId: 'P-1' },
            userPrincipal('u', []),
            {},
        );
        expect(run.status).toBe('completed');
    });

    it('IdempotencyConflictError exposes the conflicting key', async () => {
        const runner = createRunner();
        let release: (() => void) | undefined;
        const blocker = new Promise<void>((res) => {
            release = res;
        });
        runner.registerStepKind('route', async () => {
            await blocker;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: { key: '${{ inputs.productId }}', scope: 'per-key' },
        });
        runner.use(idempotencyDedupMiddleware());

        const a = runner.dispatch(
            'wf-idem',
            { productId: 'P-42' },
            userPrincipal('u', []),
            {},
        );
        await new Promise((r) => setImmediate(r));
        try {
            await runner.dispatch(
                'wf-idem',
                { productId: 'P-42' },
                userPrincipal('u', []),
                {},
            );
            expect.fail('should have thrown IdempotencyConflictError');
        } catch (err) {
            expect(err).toBeInstanceOf(IdempotencyConflictError);
            expect((err as IdempotencyConflictError).key).toBe('P-42');
        }
        release!();
        await a;
    });

    it('service principal idempotency works with workerId scope suffix', async () => {
        const runner = createRunner();
        let release: (() => void) | undefined;
        const blocker = new Promise<void>((res) => {
            release = res;
        });
        runner.registerStepKind('route', async () => {
            await blocker;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            idempotent: {
                key: '${{ inputs.cronTick }}',
                scope: 'per-key-and-principal',
            },
        });
        runner.use(idempotencyDedupMiddleware());

        const first = runner.dispatch(
            'wf-idem',
            { cronTick: 'tick-1' },
            servicePrincipal('worker-A', 'req-1'),
            {},
        );
        await new Promise((r) => setImmediate(r));
        // Same worker, same tick → conflict
        await expect(
            runner.dispatch(
                'wf-idem',
                { cronTick: 'tick-1' },
                servicePrincipal('worker-A', 'req-2'),
                {},
            ),
        ).rejects.toThrow(IdempotencyConflictError);
        // Different worker, same tick → OK (different principal scope)
        const otherPromise = runner.dispatch(
            'wf-idem',
            { cronTick: 'tick-1' },
            servicePrincipal('worker-B', 'req-3'),
            {},
        );
        await new Promise((r) => setImmediate(r));
        release!();
        await Promise.all([first, otherPromise]);
    });
});
