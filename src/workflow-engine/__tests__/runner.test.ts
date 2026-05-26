import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner';
import { createMockHarness } from '../../harness/mock';
import {
    userPrincipal,
    servicePrincipal,
    isUserPrincipal,
    isServicePrincipal,
    narrowPrincipalScopes,
} from '../principal';
import type { FactEvent } from '../types/event';
import type { WorkflowDetail, WorkflowReader } from '../workflow-reader';
import type { WorkflowDeclaration } from '../../workflows/types';
import type { Run } from '../types/runner';

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
            if (name !== decl.name) return undefined;
            return detail;
        },
    };
}

describe('createRunner.dispatch', () => {
    it('dispatches a single-step workflow against a route handler (user principal)', async () => {
        const runner = createRunner();
        const events: FactEvent[] = [];
        await runner.subscribeEvents({ onEvent: (e) => events.push(e) });
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: { ok: true },
        }));
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf1',
                description: 'd',
                version: 1,
                steps: { s1: { kind: 'route', uri: 'x://y' } },
            }),
        );
        const run: Run<{ s1: { ok: boolean } }> = await runner.dispatch(
            'wf1',
            {},
            userPrincipal('u', ['x']),
            { tier: 'A' },
        );
        expect(run.status).toBe('completed');
        expect(run.output).toEqual({ s1: { ok: true } });
        expect(run.runId).toBeDefined();
        expect(run.surfaceRunId).toBe(run.runId);
        expect(run.error).toBeUndefined();
        expect(events.map((e) => e.type)).toEqual([
            'fact.run_started',
            'fact.node_completed',
            'fact.run_terminated',
        ]);
    });

    it('dispatches with a service principal — empty scopes, principal kind threaded through', async () => {
        const runner = createRunner();
        const events: FactEvent[] = [];
        await runner.subscribeEvents({ onEvent: (e) => events.push(e) });
        let observedPrincipalKind: string | undefined;
        runner.registerStepKind('route', async (_step, ctx) => {
            observedPrincipalKind = ctx.principal.kind;
            return { kind: 'completed', output: { ok: true } };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-service',
                description: 'd',
                version: 1,
                steps: { s1: { kind: 'route', uri: 'x://y' } },
            }),
        );
        const run = await runner.dispatch(
            'wf-service',
            {},
            servicePrincipal('autofill-worker', 'req-42'),
            {},
        );
        expect(run.status).toBe('completed');
        expect(observedPrincipalKind).toBe('service');
        const started = events.find((e) => e.type === 'fact.run_started');
        expect(started?.routing).toMatchObject({
            principalKind: 'service',
            workerId: 'autofill-worker',
            requestId: 'req-42',
        });
    });

    it('threads typed routing fields (tier, surfaceRunId, parentRunId) into the handler context', async () => {
        const runner = createRunner();
        let observed: { tier?: string; surfaceRunId?: string; parentRunId?: string } | undefined;
        runner.registerStepKind('route', async (_step, ctx) => {
            observed = {
                tier: ctx.routing.tier,
                surfaceRunId: ctx.routing.surfaceRunId,
                parentRunId: ctx.routing.parentRunId,
            };
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-routing',
                description: 'd',
                version: 1,
                steps: { s1: { kind: 'route', uri: 'x://y' } },
            }),
        );
        const run = await runner.dispatch(
            'wf-routing',
            {},
            userPrincipal('u', []),
            {
                tier: 'A',
                surfaceRunId: 'surface-123',
                parentRunId: 'parent-456',
            },
        );
        expect(run.surfaceRunId).toBe('surface-123');
        expect(observed).toEqual({
            tier: 'A',
            surfaceRunId: 'surface-123',
            parentRunId: 'parent-456',
        });
    });

    it('rejects when no workflow reader registered', async () => {
        const runner = createRunner();
        await expect(
            runner.dispatch('wf1', {}, userPrincipal('u', []), {}),
        ).rejects.toThrow(/no workflow reader/);
    });

    it('rejects when workflow not found', async () => {
        const runner = createRunner();
        runner.registerWorkflowReader({
            async list() {
                return [];
            },
            async read() {
                return undefined;
            },
        });
        await expect(
            runner.dispatch('nope', {}, userPrincipal('u', []), {}),
        ).rejects.toThrow(/not found/);
    });

    it('routes paused_human through resumeRun end-to-end', async () => {
        const runner = createRunner();
        const events: FactEvent[] = [];
        await runner.subscribeEvents({ onEvent: (e) => events.push(e) });
        runner.registerStepKind('input', async () => ({
            kind: 'paused_human',
            prompt: 'Pick',
            routes: ['a'],
            schema: {
                type: 'object',
                properties: { choice: { type: 'string', enum: ['a'] } },
                required: ['choice'],
            },
        }));
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-hitl',
                description: 'd',
                version: 1,
                steps: {
                    s1: { kind: 'input', schema: {} as any, prompt: 'pick' },
                },
            }),
        );
        const runPromise = runner.dispatch(
            'wf-hitl',
            {},
            userPrincipal('u', []),
            {},
        );
        // Wait for pause to land.
        await new Promise((r) => setTimeout(r, 5));
        const paused = events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as any).promptId as string;
        await runner.resumeRun({
            runId: paused!.runId,
            promptId,
            value: { choice: 'a' },
        });
        const result = await runPromise;
        expect(result.status).toBe('completed');
        expect((result.output as any)?.s1).toEqual({ choice: 'a' });
    });

    it('drives a real agent step via the mock harness end-to-end', async () => {
        const runner = createRunner();
        const harness = createMockHarness({
            script: ({ runId }) => [
                {
                    kind: 'assistant_message',
                    content: [{ type: 'text', text: 'hi' }],
                    runId,
                },
                { kind: 'usage', inputTokens: 1, outputTokens: 1, runId },
                { kind: 'status', status: 'completed', runId },
            ],
        });
        runner.registerStepKind('agent', async (step) => {
            const agent = await harness.createAgent({
                systemPrompt: (step as any).systemPrompt,
                model: (step as any).model,
            });
            const handle = await agent.send((step as any).prompt);
            for await (const _ev of handle.stream()) {
                /* drain */
            }
            const result = await handle.wait();
            return {
                kind: 'completed',
                output: { rawText: result.rawText ?? null, runId: result.runId },
            };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-agent',
                description: 'd',
                version: 1,
                steps: {
                    s1: {
                        kind: 'agent',
                        model: 'claude-opus-4-7',
                        systemPrompt: 'you are a test',
                        prompt: 'hi',
                    } as any,
                },
            }),
        );
        const res = await runner.dispatch(
            'wf-agent',
            {},
            userPrincipal('u', []),
            {},
        );
        expect(res.status).toBe('completed');
        expect((res.output as any)?.s1).toBeDefined();
    });

    it('abortRun aborts the running step via the run signal', async () => {
        const runner = createRunner();
        const events: FactEvent[] = [];
        await runner.subscribeEvents({ onEvent: (e) => events.push(e) });
        runner.registerStepKind('route', async (_step, ctx) => {
            return await new Promise((resolve) => {
                ctx.signal.addEventListener('abort', () =>
                    resolve({
                        kind: 'error',
                        code: 'aborted',
                        message: 'cancelled',
                    }),
                );
            });
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-abort',
                description: 'd',
                version: 1,
                steps: { s1: { kind: 'route', uri: 'x://y' } },
            }),
        );
        const runPromise = runner.dispatch(
            'wf-abort',
            {},
            userPrincipal('u', []),
            {},
        );
        // Wait until run_started lands so we know the run id.
        await new Promise((r) => setTimeout(r, 5));
        const started = events.find((e) => e.type === 'fact.run_started');
        expect(started).toBeDefined();
        const runId = started!.runId;
        await runner.abortRun(runId);
        const result = await runPromise;
        // The step resolved with `error` after abort, so the walker
        // emits errored — either is acceptable; assert it terminated.
        expect(['errored', 'canceled']).toContain(result.status);
    });
});

describe('Principal helpers', () => {
    it('userPrincipal builds a typed user principal with scopes as ReadonlySet', () => {
        const p = userPrincipal('alice', ['marketing:read', 'cs:read'], 'a@b.com');
        expect(p.kind).toBe('user');
        expect(isUserPrincipal(p)).toBe(true);
        expect(isServicePrincipal(p)).toBe(false);
        expect(p.userId).toBe('alice');
        expect(p.scopes.has('marketing:read')).toBe(true);
        expect(p.scopes.has('cs:read')).toBe(true);
        expect(p.email).toBe('a@b.com');
    });

    it('servicePrincipal builds a typed service principal with workerId + requestId', () => {
        const p = servicePrincipal('autofill-worker', 'req-1');
        expect(p.kind).toBe('service');
        expect(isServicePrincipal(p)).toBe(true);
        expect(isUserPrincipal(p)).toBe(false);
        expect(p.workerId).toBe('autofill-worker');
        expect(p.requestId).toBe('req-1');
    });

    it('narrowPrincipalScopes intersects user scopes with declared scopes', () => {
        const parent = userPrincipal('alice', ['marketing:read', 'cs:read', 'payments:read']);
        const narrowed = narrowPrincipalScopes(parent, ['marketing:read', 'striga:read']);
        expect(narrowed.kind).toBe('user');
        if (narrowed.kind !== 'user') throw new Error('unreachable');
        expect(narrowed.scopes.has('marketing:read')).toBe(true);
        expect(narrowed.scopes.has('cs:read')).toBe(false);
        expect(narrowed.scopes.has('striga:read')).toBe(false);
    });

    it('narrowPrincipalScopes returns service principal unchanged', () => {
        const parent = servicePrincipal('worker', 'req-1');
        const narrowed = narrowPrincipalScopes(parent, ['marketing:read']);
        expect(narrowed).toBe(parent);
    });

    it('narrowPrincipalScopes returns parent unchanged when declared scopes is empty', () => {
        const parent = userPrincipal('alice', ['marketing:read']);
        const narrowed = narrowPrincipalScopes(parent, []);
        expect(narrowed).toBe(parent);
    });
});
