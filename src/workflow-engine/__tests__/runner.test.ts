import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner';
import { createMockHarness } from '../../harness/mock';
import type { FactEvent } from '../types/event';
import type { WorkflowDetail, WorkflowReader } from '../workflow-reader';
import type { WorkflowDeclaration } from '../../workflows/types';

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

describe('createRunner', () => {
    it('dispatches a single-step workflow against a route handler', async () => {
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
        const res = await runner.dispatchWorkflow({
            slug: 'wf1',
            inputs: {},
            principal: { userId: 'u', scopes: new Set(['x']) },
            context: { tier: 'A' },
        });
        expect(res.status).toBe('completed');
        expect(res.outputs).toEqual({ s1: { ok: true } });
        expect(events.map((e) => e.type)).toEqual([
            'fact.run_started',
            'fact.node_completed',
            'fact.run_terminated',
        ]);
    });

    it('rejects when no workflow reader registered', async () => {
        const runner = createRunner();
        await expect(
            runner.dispatchWorkflow({
                slug: 'wf1',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            }),
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
            runner.dispatchWorkflow({
                slug: 'nope',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            }),
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
        const runPromise = runner.dispatchWorkflow({
            slug: 'wf-hitl',
            inputs: {},
            principal: { userId: 'u', scopes: new Set() },
            context: {},
        });
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
        expect(result.outputs.s1).toEqual({ choice: 'a' });
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
        const res = await runner.dispatchWorkflow({
            slug: 'wf-agent',
            inputs: {},
            principal: { userId: 'u', scopes: new Set() },
            context: {},
        });
        expect(res.status).toBe('completed');
        expect(res.outputs.s1).toBeDefined();
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
        const runPromise = runner.dispatchWorkflow({
            slug: 'wf-abort',
            inputs: {},
            principal: { userId: 'u', scopes: new Set() },
            context: {},
        });
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
