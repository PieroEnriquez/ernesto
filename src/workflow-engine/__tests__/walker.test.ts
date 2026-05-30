import { describe, it, expect } from 'vitest';
import { walk } from '../engine/walker';
import { userPrincipal } from '../principal';
import { EventBus } from '../event-bus';
import { HandlerDispatcher } from '../dispatch';
import { InMemoryStore } from '../store/in-memory-store';
import { HitlController } from '../hitl';
import type { FactEvent } from '../types/event';
import type { WorkflowDeclaration } from '../../workflows/types';

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
                kind: 'wf1',
                inputs: {},
                principal: userPrincipal('u', []),
                opts: {},
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
                kind: 'wf2',
                inputs: {},
                principal: userPrincipal('u', []),
                opts: {},
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

    it('parks (durably) on paused_human without blocking siblings', async () => {
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
                // s1 parks; the independent s2 keeps running.
                s1: { kind: 'input', schema: {} as any, prompt: 'pick' },
                s2: { kind: 'route', uri: 'x://y' },
            },
        };
        // walk returns as soon as the run parks — NOT blocked on resume.
        const result = await walk(
            'run-3',
            decl,
            {
                kind: 'wf3',
                inputs: {},
                principal: userPrincipal('u', []),
                opts: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('paused');
        // The independent sibling completed before the run parked.
        expect(result.outputs.s2).toEqual({ done: true });
        // No terminal event — the run is parked, not finished.
        expect(
            rig.events.find((e) => e.type === 'fact.run_terminated'),
        ).toBeUndefined();
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as any).promptId as string;
        // The durable resume blob carries the parked step + its promptId.
        const state = await rig.store.getRunState('run-3');
        expect(state?.status).toBe('paused');
        expect(state?.resume?.paused).toHaveLength(1);
        expect(state?.resume?.paused[0]?.stepId).toBe('s1');
        expect(state?.resume?.paused[0]?.promptId).toBe(promptId);
        expect(state?.resume?.outputs).toEqual({ s2: { done: true } });
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
                kind: 'wf4',
                inputs: {},
                principal: userPrincipal('u', []),
                opts: { abortSignal: ac.signal },
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('canceled');
        const state = await rig.store.getRunState('run-4');
        expect(state?.status).toBe('aborted');
    });

    it('threads ctx.emit() so handlers can publish in-step fact events', async () => {
        const rig = makeRig();
        rig.dispatcher.register('agent', async (_step, ctx) => {
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
                    kind: 'agent',
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
                kind: 'wf-emit',
                inputs: {},
                principal: userPrincipal('u', []),
                opts: {},
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
        rig.dispatcher.register('agent', async (_step, ctx) => {
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
                    kind: 'agent',
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
                kind: 'wf-component',
                inputs: {},
                principal: userPrincipal('u', []),
                opts: {},
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

    it('walks a render manifest on step output and strips render before recording', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async () => ({
            kind: 'completed',
            output: {
                metric: 42,
                rows: [{ a: 1 }, { a: 2 }],
                render: [
                    { path: 'metric', ui: 'metric', label: 'count' },
                    {
                        path: 'rows',
                        ui: 'table',
                        columns: [{ id: 'a', label: 'A' }],
                    },
                ],
            },
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-manifest',
            description: 'd',
            version: 1,
            steps: { s1: { kind: 'route', uri: 'x://y' } },
        };
        const result = await walk(
            'run-manifest',
            decl,
            {
                kind: 'wf-manifest',
                inputs: {},
                principal: userPrincipal('u', []),
                opts: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('completed');
        // `render` key stripped — downstream `{ from: s1 }` sees data only.
        expect(result.outputs.s1).toEqual({
            metric: 42,
            rows: [{ a: 1 }, { a: 2 }],
        });
        const componentEvents = rig.events.filter(
            (e) => e.type === 'fact.component',
        );
        expect(componentEvents.length).toBe(2);
        expect(componentEvents[0]!.payload).toMatchObject({
            stepId: 's1',
            component: { kind: 'metric', props: { label: 'count', value: 42 } },
        });
        expect(componentEvents[1]!.payload).toMatchObject({
            stepId: 's1',
            component: {
                kind: 'table',
                props: {
                    columns: [{ id: 'a', label: 'A' }],
                    rows: [{ a: 1 }, { a: 2 }],
                },
            },
        });
        // node_completed payload sees the stripped output too.
        const completed = rig.events.find((e) => e.type === 'fact.node_completed');
        expect(completed?.payload).toMatchObject({
            nodeId: 's1',
            output: { metric: 42, rows: [{ a: 1 }, { a: 2 }] },
        });
    });

    it('leaves outputs untouched when render field is absent or empty', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async (_step, _ctx) => ({
            kind: 'completed',
            output: { plain: 'value', render: [] },
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-empty-manifest',
            description: 'd',
            version: 1,
            steps: { s1: { kind: 'route', uri: 'x://y' } },
        };
        const result = await walk(
            'run-empty-manifest',
            decl,
            {
                kind: 'wf-empty-manifest',
                inputs: {},
                principal: userPrincipal('u', []),
                opts: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.outputs.s1).toEqual({ plain: 'value', render: [] });
        const componentEvents = rig.events.filter(
            (e) => e.type === 'fact.component',
        );
        expect(componentEvents.length).toBe(0);
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
                kind: 'wf5',
                inputs: {},
                principal: userPrincipal('u', []),
                opts: {},
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

describe('walker — DAG semantics', () => {
    it('threads ${{ steps.X.outputs.Y }} from one step to the next via depends', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async (step) => ({
            kind: 'completed',
            output: { echoed: (step as { params?: { in?: unknown } }).params?.in ?? null },
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-dag',
            description: 'd',
            version: 1,
            steps: {
                first: { kind: 'route', uri: 'x://y', params: { in: 'hello' } },
                second: {
                    kind: 'route',
                    uri: 'x://z',
                    params: { in: '${{ steps.first.outputs.echoed }}' },
                    depends: ['first'],
                },
            },
        };
        const result = await walk(
            'run-dag',
            decl,
            { kind: 'wf-dag', inputs: {}, principal: userPrincipal('u', []), opts: {} },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('completed');
        expect((result.outputs.second as { echoed: string }).echoed).toBe('hello');
    });

    it('skipIf skips a step without dispatching its handler', async () => {
        const rig = makeRig();
        let calls = 0;
        rig.dispatcher.register('route', async () => {
            calls++;
            return { kind: 'completed', output: { ok: true } };
        });
        const decl: WorkflowDeclaration = {
            name: 'wf-skip',
            description: 'd',
            version: 1,
            steps: {
                gate: { kind: 'route', uri: 'x://gate' },
                skipped: {
                    kind: 'route',
                    uri: 'x://never',
                    depends: ['gate'],
                    skipIf: '${{ steps.gate.outputs.ok }}',
                },
            },
        };
        const result = await walk(
            'run-skip',
            decl,
            { kind: 'wf-skip', inputs: {}, principal: userPrincipal('u', []), opts: {} },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('completed');
        // gate ran (1), skipped did not.
        expect(calls).toBe(1);
        expect(result.outputs.skipped).toMatchObject({ skipped: true });
    });

    it('runs a nested group sub-DAG and namespaces its output', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async (step) => ({
            kind: 'completed',
            output: { uri: (step as { uri: string }).uri },
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-group',
            description: 'd',
            version: 1,
            steps: {
                grp: {
                    kind: 'group',
                    steps: {
                        a: { kind: 'route', uri: 'x://a' },
                        b: { kind: 'route', uri: 'x://b' },
                    },
                },
            },
        };
        const result = await walk(
            'run-group',
            decl,
            { kind: 'wf-group', inputs: {}, principal: userPrincipal('u', []), opts: {} },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('completed');
        // The group node's output is its child-output map.
        expect(result.outputs.grp).toMatchObject({
            a: { uri: 'x://a' },
            b: { uri: 'x://b' },
        });
    });
});
