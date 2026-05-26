/**
 * Tests for the runner's built-in retry feature (reads
 * `kind.policy.retry.{max, backoffMs}`).
 *
 * Retry is a runner concern rather than a middleware because the
 * middleware contract today doesn't support re-invoking the walk —
 * `before` transforms ctx, `after` consumes the result, but neither
 * wraps the walk call. Built-in retry inside the runner's dispatch
 * loop is the simplest correct shape.
 */

import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner';
import { userPrincipal } from '../principal';
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
    name: 'wf',
    description: 'd',
    version: 1,
    steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
};

describe('runner retry — kind.policy.retry', () => {
    it('retries on errored status up to max', async () => {
        const runner = createRunner();
        let calls = 0;
        runner.registerStepKind('route', async () => {
            calls++;
            if (calls < 3) {
                return { kind: 'error', code: 'transient', message: 'try again' };
            }
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            retry: { max: 5, backoffMs: 0 },
        });

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
        expect(calls).toBe(3);
    });

    it('stops after max attempts and surfaces the final error', async () => {
        const runner = createRunner();
        let calls = 0;
        runner.registerStepKind('route', async () => {
            calls++;
            return { kind: 'error', code: 'boom', message: `fail-${calls}` };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            retry: { max: 3, backoffMs: 0 },
        });

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('errored');
        expect(calls).toBe(3);
        expect(run.error?.message).toContain('fail-3');
    });

    it('no policy → no retry (one attempt)', async () => {
        const runner = createRunner();
        let calls = 0;
        runner.registerStepKind('route', async () => {
            calls++;
            return { kind: 'error', code: 'boom', message: 'oh' };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL); // no retry policy

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('errored');
        expect(calls).toBe(1);
    });

    it('does NOT retry on completed status (first success terminates)', async () => {
        const runner = createRunner();
        let calls = 0;
        runner.registerStepKind('route', async () => {
            calls++;
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            retry: { max: 5, backoffMs: 0 },
        });

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
        expect(calls).toBe(1);
    });

    it('honors backoffMs between attempts', async () => {
        const runner = createRunner();
        const callTimes: number[] = [];
        runner.registerStepKind('route', async () => {
            callTimes.push(Date.now());
            return { kind: 'error', code: 'boom', message: 'fail' };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            retry: { max: 3, backoffMs: 30 },
        });

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(callTimes.length).toBe(3);
        // Each consecutive attempt should be at least 30ms after the prior
        for (let i = 1; i < callTimes.length; i++) {
            expect(callTimes[i]! - callTimes[i - 1]!).toBeGreaterThanOrEqual(25);
        }
    });

    it('abort signal cooperatively stops retry loop', async () => {
        const runner = createRunner();
        let calls = 0;
        runner.registerStepKind('route', async () => {
            calls++;
            return { kind: 'error', code: 'boom', message: 'fail' };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            retry: { max: 100, backoffMs: 50 },
        });

        const ac = new AbortController();
        const dispatchPromise = runner.dispatch(
            'wf',
            {},
            userPrincipal('u', []),
            { abortSignal: ac.signal },
        );
        // Abort after first attempt completes + during backoff
        setTimeout(() => ac.abort(), 25);
        const run = await dispatchPromise;
        expect(run.status).toBe('errored');
        expect(calls).toBeLessThan(5); // not all 100
    });

    it('respects after-hooks running with the final terminal run only', async () => {
        const runner = createRunner();
        let attempts = 0;
        const afterCalls: number[] = [];
        runner.registerStepKind('route', async () => {
            attempts++;
            if (attempts < 2) {
                return { kind: 'error', code: 'transient', message: 'retry' };
            }
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            retry: { max: 3, backoffMs: 0 },
        });
        runner.use({
            name: 'after-only',
            after(_ctx, run) {
                afterCalls.push(attempts);
                expect(run.status).toBe('completed');
            },
        });

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
        // After hook should fire ONCE with the final terminal run
        expect(afterCalls).toEqual([2]);
    });
});

describe('walker — annotations plumbing', () => {
    it('plumbs middleware-set annotations into HandlerContext.annotations', async () => {
        const runner = createRunner();
        let observedAnnotation: unknown;
        runner.registerStepKind('route', async (_step, ctx) => {
            observedAnnotation = ctx.annotations.injected;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL);
        runner.use({
            name: 'injector',
            before(ctx) {
                ctx.annotations.injected = 'from-middleware';
                return ctx;
            },
        });

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(observedAnnotation).toBe('from-middleware');
    });

    it('annotations default to empty {} when no middleware writes', async () => {
        const runner = createRunner();
        let observedAnnotations: unknown;
        runner.registerStepKind('route', async (_step, ctx) => {
            observedAnnotations = ctx.annotations;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(observedAnnotations).toEqual({});
    });
});
