/**
 * Tests for `resultCacheMiddleware` — the cache hit short-circuits
 * dispatch when the kind declares `policy.cacheable.ttlMs` and a
 * fresh cached output exists. Cache miss + successful completion
 * writes the result for the next call within TTL.
 */

import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner';
import { userPrincipal, servicePrincipal } from '../principal';
import { resultCacheMiddleware, InMemoryResultCache } from '../middleware/result-cache';
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

describe('resultCacheMiddleware', () => {
    it('serves cached output on the second call within TTL — handler runs once', async () => {
        const runner = createRunner();
        let handlerCalls = 0;
        runner.registerStepKind('route', async () => {
            handlerCalls++;
            return { kind: 'completed', output: { rows: ['a', 'b'] } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            cacheable: { ttlMs: 60_000 },
        });
        runner.use(resultCacheMiddleware());

        const r1 = await runner.dispatch('wf', { date: '2026-05-26' }, userPrincipal('u', []), {});
        expect(r1.status).toBe('completed');
        expect(handlerCalls).toBe(1);

        const r2 = await runner.dispatch('wf', { date: '2026-05-26' }, userPrincipal('u', []), {});
        expect(r2.status).toBe('completed');
        // Cache hit: handler not invoked again.
        expect(handlerCalls).toBe(1);
        // Same outputs surface.
        expect(r2.output).toEqual(r1.output);
    });

    it('does not cache when policy.cacheable is absent', async () => {
        const runner = createRunner();
        let handlerCalls = 0;
        runner.registerStepKind('route', async () => {
            handlerCalls++;
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL); // no cacheable
        runner.use(resultCacheMiddleware());

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(handlerCalls).toBe(2);
    });

    it('different inputs produce different cache keys', async () => {
        const runner = createRunner();
        let handlerCalls = 0;
        runner.registerStepKind('route', async (_step, ctx) => {
            handlerCalls++;
            return { kind: 'completed', output: { run: handlerCalls, inputs: ctx.runInputs } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            cacheable: { ttlMs: 60_000 },
        });
        runner.use(resultCacheMiddleware());

        await runner.dispatch('wf', { date: 'A' }, userPrincipal('u', []), {});
        await runner.dispatch('wf', { date: 'B' }, userPrincipal('u', []), {});
        await runner.dispatch('wf', { date: 'A' }, userPrincipal('u', []), {});
        // First two are unique → 2 handler calls. Third re-uses 'A' → cache hit, no new call.
        expect(handlerCalls).toBe(2);
    });

    it('keys cache per principal so user-A reads never satisfy user-B', async () => {
        const runner = createRunner();
        let handlerCalls = 0;
        runner.registerStepKind('route', async () => {
            handlerCalls++;
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            cacheable: { ttlMs: 60_000 },
        });
        runner.use(resultCacheMiddleware());

        await runner.dispatch('wf', { x: 1 }, userPrincipal('alice', []), {});
        await runner.dispatch('wf', { x: 1 }, userPrincipal('bob', []), {});
        await runner.dispatch('wf', { x: 1 }, userPrincipal('alice', []), {});
        // alice + bob each get a separate cache slot, but alice's second call hits.
        expect(handlerCalls).toBe(2);
    });

    it('expires cached entries after TTL elapses', async () => {
        const fakeClock = { ms: 1_000_000 };
        const now = () => fakeClock.ms;
        const store = new InMemoryResultCache(now);
        const runner = createRunner();
        let handlerCalls = 0;
        runner.registerStepKind('route', async () => {
            handlerCalls++;
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            cacheable: { ttlMs: 1_000 },
        });
        runner.use(resultCacheMiddleware({ store, now }));

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(handlerCalls).toBe(1);

        // Within TTL.
        fakeClock.ms += 500;
        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(handlerCalls).toBe(1);

        // Past TTL.
        fakeClock.ms += 600;
        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(handlerCalls).toBe(2);
    });

    it('does not cache errored runs', async () => {
        const runner = createRunner();
        let handlerCalls = 0;
        runner.registerStepKind('route', async () => {
            handlerCalls++;
            if (handlerCalls < 2) {
                return { kind: 'error', code: 'boom', message: 'fail' };
            }
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            cacheable: { ttlMs: 60_000 },
        });
        runner.use(resultCacheMiddleware());

        // First call errors — not cached. Second call hits the route
        // again (which now succeeds). Third call serves the cached
        // success.
        const r1 = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(r1.status).toBe('errored');
        const r2 = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(r2.status).toBe('completed');
        const r3 = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(r3.status).toBe('completed');
        expect(handlerCalls).toBe(2); // 1 errored + 1 completed; r3 is cached
    });

    it('honors object-key order invariance — {a,b} and {b,a} share a cache slot', async () => {
        const runner = createRunner();
        let handlerCalls = 0;
        runner.registerStepKind('route', async () => {
            handlerCalls++;
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            cacheable: { ttlMs: 60_000 },
        });
        runner.use(resultCacheMiddleware());

        await runner.dispatch('wf', { a: 1, b: 2 }, userPrincipal('u', []), {});
        await runner.dispatch('wf', { b: 2, a: 1 }, userPrincipal('u', []), {});
        // Stable stringify sorts keys; both calls share a cache slot.
        expect(handlerCalls).toBe(1);
    });

    it('service principals get a stable per-worker cache slot', async () => {
        const runner = createRunner();
        let handlerCalls = 0;
        runner.registerStepKind('route', async () => {
            handlerCalls++;
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            cacheable: { ttlMs: 60_000 },
        });
        runner.use(resultCacheMiddleware());

        await runner.dispatch('wf', {}, servicePrincipal('worker-1', 'req-1'), {});
        await runner.dispatch('wf', {}, servicePrincipal('worker-1', 'req-2'), {});
        // Same workerId → cache hit on the second call even though
        // the requestId differs (requestId isn't part of the default
        // key).
        expect(handlerCalls).toBe(1);
    });
});
