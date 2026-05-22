import { describe, it, expect } from 'vitest';
import { walk } from '../engine/walker';
import { EventBus } from '../event-bus';
import { HandlerDispatcher } from '../dispatch';
import { InMemoryStore } from '../store/in-memory-store';
import { HitlController } from '../hitl';
import type { FactEvent } from '../types/event';
import type { WorkflowDeclaration } from '../../workflows/types';
import { pickNextStepId, isTerminalDest } from '../engine/edge-selection';

function makeRig(): {
    bus: EventBus;
    dispatcher: HandlerDispatcher;
    store: InMemoryStore;
    hitl: HitlController;
    events: FactEvent[];
    nextSeq: (runId: string) => number;
} {
    const bus = new EventBus();
    const store = new InMemoryStore();
    const dispatcher = new HandlerDispatcher();
    const seqByRun = new Map<string, number>();
    const nextSeq = (runId: string): number => {
        const v = seqByRun.get(runId) ?? 0;
        seqByRun.set(runId, v + 1);
        return v;
    };
    const hitl = new HitlController(bus, store, nextSeq);
    const events: FactEvent[] = [];
    bus.subscribe({ onEvent: (e) => events.push(e) });
    return { bus, dispatcher, store, hitl, events, nextSeq };
}

const NOOP_LOG = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

describe('walker', () => {
    it('walks the step graph and emits node_completed + run_terminated', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async () => ({
            kind: 'completed',
            output: { ok: true },
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf1',
            description: 'd',
            version: 1,
            steps: {
                s1: { kind: 'route', uri: 'foo://bar' },
            },
        };
        const result = await walk(
            'run-1',
            decl,
            {
                slug: 'wf1',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('completed');
        expect(result.outputs).toEqual({ s1: { ok: true } });
        const types = rig.events.map((e) => e.type);
        expect(types).toEqual([
            'fact.run_started',
            'fact.node_completed',
            'fact.run_terminated',
        ]);
        const state = await rig.store.getRunState('run-1');
        expect(state?.status).toBe('completed');
        expect(state?.endedAt).toBeDefined();
    });

    it('emits errored terminal on handler error', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async () => ({
            kind: 'error',
            code: 'boom',
            message: 'failed',
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf2',
            description: 'd',
            version: 1,
            steps: { s1: { kind: 'route', uri: 'x://y' } },
        };
        const result = await walk(
            'run-2',
            decl,
            {
                slug: 'wf2',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('errored');
        const terminal = rig.events.find(
            (e) => e.type === 'fact.run_terminated',
        );
        expect(terminal?.payload).toMatchObject({
            status: 'errored',
            code: 'boom',
        });
        const state = await rig.store.getRunState('run-2');
        expect(state?.status).toBe('errored');
    });

    it('pauses on paused_human and resumes via HITL controller', async () => {
        const rig = makeRig();
        rig.dispatcher.register('input', async () => ({
            kind: 'paused_human',
            prompt: 'Pick',
            routes: ['a', 'b'],
            schema: {
                type: 'object',
                properties: { choice: { type: 'string', enum: ['a', 'b'] } },
                required: ['choice'],
            },
        }));
        rig.dispatcher.register('route', async () => ({
            kind: 'completed',
            output: { done: true },
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf3',
            description: 'd',
            version: 1,
            steps: {
                s1: { kind: 'input', schema: {} as any, prompt: 'pick' },
                s2: { kind: 'route', uri: 'x://y' },
            },
        };
        const runPromise = walk(
            'run-3',
            decl,
            {
                slug: 'wf3',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        // Let the pause emit + state-write settle.
        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as any).promptId as string;
        await rig.hitl.resume('run-3', {
            promptId,
            value: { choice: 'a' },
        });
        const result = await runPromise;
        expect(result.status).toBe('completed');
        expect(result.outputs.s1).toEqual({ choice: 'a' });
        expect(result.outputs.s2).toEqual({ done: true });
    });

    it('marks the run aborted when the abort signal fires', async () => {
        const rig = makeRig();
        const ac = new AbortController();
        ac.abort();
        rig.dispatcher.register('route', async () => ({
            kind: 'completed',
            output: null,
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf4',
            description: 'd',
            version: 1,
            steps: { s1: { kind: 'route', uri: 'x://y' } },
        };
        const result = await walk(
            'run-4',
            decl,
            {
                slug: 'wf4',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
                signal: ac.signal,
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('canceled');
        const state = await rig.store.getRunState('run-4');
        expect(state?.status).toBe('aborted');
    });

    it('threads ctx.emit() so handlers can publish in-step fact events', async () => {
        const rig = makeRig();
        rig.dispatcher.register('agent-cas', async (_step, ctx) => {
            // Forward every HarnessEvent variant the brief calls out as
            // its corresponding `fact.*` event, mirroring what the
            // backend's `runAgentStepKind` will do per-iteration.
            ctx.emit!({
                type: 'fact.assistant_delta',
                text: 'partial ',
            });
            ctx.emit!({
                type: 'fact.tool_call',
                toolUseId: 'tu-1',
                name: 'Read',
                input: { path: '/x' },
            });
            ctx.emit!({
                type: 'fact.tool_result',
                toolUseId: 'tu-1',
                output: 'ok',
                isError: false,
            });
            ctx.emit!({
                type: 'fact.thinking',
                text: 'hmm',
            });
            ctx.emit!({
                type: 'fact.usage',
                inputTokens: 10,
                outputTokens: 20,
                cacheRead: 1,
                cacheWrite: 2,
                costUsd: 0.001,
            });
            ctx.emit!({
                type: 'fact.subagent_started',
                slug: 'translate',
                subRunId: 'child-1',
            });
            ctx.emit!({
                type: 'fact.subagent_completed',
                slug: 'translate',
                subRunId: 'child-1',
                result: { ok: true },
            });
            ctx.emit!({
                type: 'fact.assistant_message',
                content: [{ type: 'text', text: 'final' }],
            });
            return { kind: 'completed', output: { ok: true } };
        });
        const decl: WorkflowDeclaration = {
            name: 'wf-emit',
            description: 'd',
            version: 1,
            steps: {
                s1: {
                    kind: 'agent-cas',
                    model: 'm',
                    systemPrompt: 'sp',
                    prompt: 'p',
                } as any,
            },
        };
        await walk(
            'run-emit',
            decl,
            {
                slug: 'wf-emit',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        const types = rig.events.map((e) => e.type);
        expect(types).toEqual([
            'fact.run_started',
            'fact.assistant_delta',
            'fact.tool_call',
            'fact.tool_result',
            'fact.thinking',
            'fact.usage',
            'fact.subagent_started',
            'fact.subagent_completed',
            'fact.assistant_message',
            'fact.node_completed',
            'fact.run_terminated',
        ]);
        const delta = rig.events.find((e) => e.type === 'fact.assistant_delta');
        expect(delta?.payload).toMatchObject({ stepId: 's1', text: 'partial ' });
        const toolCall = rig.events.find((e) => e.type === 'fact.tool_call');
        expect(toolCall?.payload).toMatchObject({
            stepId: 's1',
            toolUseId: 'tu-1',
            name: 'Read',
            input: { path: '/x' },
        });
        const toolResult = rig.events.find((e) => e.type === 'fact.tool_result');
        expect(toolResult?.payload).toMatchObject({
            stepId: 's1',
            toolUseId: 'tu-1',
            output: 'ok',
            isError: false,
        });
        const thinking = rig.events.find((e) => e.type === 'fact.thinking');
        expect(thinking?.payload).toMatchObject({ stepId: 's1', text: 'hmm' });
        const usage = rig.events.find((e) => e.type === 'fact.usage');
        expect(usage?.payload).toMatchObject({
            stepId: 's1',
            inputTokens: 10,
            outputTokens: 20,
            cacheRead: 1,
            cacheWrite: 2,
            costUsd: 0.001,
        });
        const subStarted = rig.events.find(
            (e) => e.type === 'fact.subagent_started',
        );
        expect(subStarted?.payload).toMatchObject({
            stepId: 's1',
            slug: 'translate',
            subRunId: 'child-1',
        });
        const subCompleted = rig.events.find(
            (e) => e.type === 'fact.subagent_completed',
        );
        expect(subCompleted?.payload).toMatchObject({
            stepId: 's1',
            slug: 'translate',
            subRunId: 'child-1',
            result: { ok: true },
        });
        // Sequence is monotonic over both walker- and handler-emitted
        // events — store side enforces it.
        const stored = await rig.store.listEvents('run-emit');
        expect(stored.length).toBe(types.length);
        for (let i = 1; i < stored.length; i++) {
            expect(stored[i]!.seq).toBe(stored[i - 1]!.seq + 1);
        }
    });

    it('forwards fact.component emits from the ui-tool handler path', async () => {
        const rig = makeRig();
        rig.dispatcher.register('agent-cas', async (_step, ctx) => {
            ctx.emit!({
                type: 'fact.component',
                component: {
                    kind: 'status',
                    props: { text: 'fetching…', level: 'progress' },
                    slotId: 'status-1',
                },
            });
            ctx.emit!({
                type: 'fact.component',
                component: {
                    kind: 'table',
                    props: {
                        columns: [{ id: 'k', label: 'K' }],
                        rows: [{ k: 'v' }],
                    },
                },
            });
            return { kind: 'completed', output: { ok: true } };
        });
        const decl: WorkflowDeclaration = {
            name: 'wf-component',
            description: 'd',
            version: 1,
            steps: {
                s1: {
                    kind: 'agent-cas',
                    model: 'm',
                    systemPrompt: 'sp',
                    prompt: 'p',
                } as any,
            },
        };
        await walk(
            'run-component',
            decl,
            {
                slug: 'wf-component',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        const componentEvents = rig.events.filter(
            (e) => e.type === 'fact.component',
        );
        expect(componentEvents.length).toBe(2);
        expect(componentEvents[0]!.payload).toMatchObject({
            stepId: 's1',
            component: {
                kind: 'status',
                props: { text: 'fetching…', level: 'progress' },
                slotId: 'status-1',
            },
        });
        expect(componentEvents[1]!.payload).toMatchObject({
            stepId: 's1',
            component: { kind: 'table' },
        });
    });

    it('appends events to the store under run id', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async () => ({
            kind: 'completed',
            output: null,
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf5',
            description: 'd',
            version: 1,
            steps: { s1: { kind: 'route', uri: 'x://y' } },
        };
        await walk(
            'run-5',
            decl,
            {
                slug: 'wf5',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        const stored = await rig.store.listEvents('run-5');
        expect(stored.length).toBe(3);
        expect(stored.map((e) => e.type)).toEqual([
            'fact.run_started',
            'fact.node_completed',
            'fact.run_terminated',
        ]);
    });
});

describe('edge-selection', () => {
    it('pickNextStepId picks from `on` first', () => {
        expect(
            pickNextStepId(
                {
                    kind: 'route',
                    uri: 'x',
                    next: 's2',
                    on: { completed: 's3' },
                } as any,
                'completed',
            ),
        ).toBe('s3');
    });
    it('pickNextStepId falls back to `next` on completed', () => {
        expect(
            pickNextStepId(
                { kind: 'route', uri: 'x', next: 's2' } as any,
                'completed',
            ),
        ).toBe('s2');
    });
    it('isTerminalDest recognises outputs sinks', () => {
        expect(isTerminalDest(undefined)).toBe(true);
        expect(isTerminalDest('outputs')).toBe(true);
        expect(isTerminalDest('outputs.result')).toBe(true);
        expect(isTerminalDest('s2')).toBe(false);
    });
});
