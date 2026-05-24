import { describe, it, expect } from 'vitest';
import { walk } from '../engine/walker';
import { EventBus } from '../event-bus';
import { HandlerDispatcher } from '../dispatch';
import { InMemoryStore } from '../store/in-memory-store';
import { HitlController } from '../hitl';
import { makeParallelHandler } from '../engine/parallel-handler';
import type { FactEvent } from '../types/event';
import type { WorkflowDeclaration } from '../../workflows/types';

const NOOP_LOG = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

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
    // Auto-register parallel here too — these tests build the dispatcher
    // by hand rather than via createRunner.
    dispatcher.register('parallel', makeParallelHandler(dispatcher));
    return { bus, dispatcher, store, hitl, events, nextSeq };
}

describe('parallel step handler', () => {
    it('runs branches concurrently and merges outputs by branch key', async () => {
        const rig = makeRig();
        const order: string[] = [];
        rig.dispatcher.register('route', async (step) => {
            const uri = (step as { uri: string }).uri;
            order.push(`start:${uri}`);
            await new Promise((r) => setTimeout(r, uri.endsWith('slow') ? 20 : 5));
            order.push(`done:${uri}`);
            return { kind: 'completed', output: { uri } };
        });
        const decl: WorkflowDeclaration = {
            name: 'wf-par',
            description: 'd',
            version: 1,
            steps: {
                fan: {
                    kind: 'parallel',
                    branches: {
                        slow: { kind: 'route', uri: 'x://slow' },
                        fast: { kind: 'route', uri: 'x://fast' },
                    },
                },
            },
        };
        const result = await walk(
            'run-par',
            decl,
            {
                slug: 'wf-par',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('completed');
        expect(result.outputs.fan).toEqual({
            slow: { uri: 'x://slow' },
            fast: { uri: 'x://fast' },
        });
        // Both branches started before either finished — proves concurrency.
        const startIdxSlow = order.indexOf('start:x://slow');
        const startIdxFast = order.indexOf('start:x://fast');
        const doneIdxSlow = order.indexOf('done:x://slow');
        const doneIdxFast = order.indexOf('done:x://fast');
        expect(startIdxSlow).toBeLessThan(doneIdxFast);
        expect(startIdxFast).toBeLessThan(doneIdxSlow);
    });

    it('first branch failure becomes the parallel step error', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async (step) => {
            const uri = (step as { uri: string }).uri;
            if (uri === 'x://boom') {
                return {
                    kind: 'error',
                    code: 'route_failed',
                    message: 'kaboom',
                };
            }
            return { kind: 'completed', output: { uri } };
        });
        const decl: WorkflowDeclaration = {
            name: 'wf-fail',
            description: 'd',
            version: 1,
            steps: {
                fan: {
                    kind: 'parallel',
                    branches: {
                        ok: { kind: 'route', uri: 'x://ok' },
                        broken: { kind: 'route', uri: 'x://boom' },
                    },
                },
            },
        };
        const result = await walk(
            'run-fail',
            decl,
            {
                slug: 'wf-fail',
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
            code: 'route_failed',
            message: expect.stringContaining('branch "broken"'),
        });
    });

    it('rejects paused_human from a branch — HITL belongs at workflow level', async () => {
        const rig = makeRig();
        rig.dispatcher.register('input', async () => ({
            kind: 'paused_human',
            prompt: 'pick',
            routes: ['a'],
        }));
        rig.dispatcher.register('route', async () => ({
            kind: 'completed',
            output: { ok: true },
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-pause',
            description: 'd',
            version: 1,
            steps: {
                fan: {
                    kind: 'parallel',
                    branches: {
                        ask: { kind: 'input', prompt: 'p', schema: {} },
                        fetch: { kind: 'route', uri: 'x://y' },
                    },
                },
            },
        };
        const result = await walk(
            'run-pause',
            decl,
            {
                slug: 'wf-pause',
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
            code: 'parallel_branch_paused',
            message: expect.stringContaining('branch "ask"'),
        });
    });

    it('per-branch render manifest fires components during the branch', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async (step) => {
            const uri = (step as { uri: string }).uri;
            if (uri === 'x://revenue') {
                return {
                    kind: 'completed',
                    output: {
                        gmv: 1234,
                        render: [
                            { path: 'gmv', ui: 'metric', label: 'GMV', unit: 'EUR' },
                        ],
                    },
                };
            }
            return { kind: 'completed', output: { count: 7 } };
        });
        const decl: WorkflowDeclaration = {
            name: 'wf-render',
            description: 'd',
            version: 1,
            steps: {
                fan: {
                    kind: 'parallel',
                    branches: {
                        revenue: { kind: 'route', uri: 'x://revenue' },
                        orders: { kind: 'route', uri: 'x://orders' },
                    },
                },
            },
        };
        const result = await walk(
            'run-render',
            decl,
            {
                slug: 'wf-render',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('completed');
        // Branch output retained, but the `render` key was stripped by
        // the projector before the merged map was assembled.
        expect(result.outputs.fan).toEqual({
            revenue: { gmv: 1234 },
            orders: { count: 7 },
        });
        const componentEvents = rig.events.filter(
            (e) => e.type === 'fact.component',
        );
        expect(componentEvents.length).toBe(1);
        expect(componentEvents[0]!.payload).toMatchObject({
            stepId: 'fan',
            component: {
                kind: 'metric',
                props: { label: 'GMV', value: 1234, unit: 'EUR' },
            },
        });
    });

    it('parent-level render manifest on parallel output fires too', async () => {
        const rig = makeRig();
        rig.dispatcher.register('route', async (step) => {
            const uri = (step as { uri: string }).uri;
            return { kind: 'completed', output: { value: uri.endsWith('a') ? 1 : 2 } };
        });
        // A wrapper that attaches a parent-level render manifest by
        // returning the merged output augmented with a `render` field —
        // demonstrates the substrate composition with the walker
        // projector at the top level.
        rig.dispatcher.register('subworkflow', async (_step, ctx) => {
            const fan = await rig.dispatcher.require('parallel')(
                {
                    kind: 'parallel',
                    branches: {
                        a: { kind: 'route', uri: 'x://a' },
                        b: { kind: 'route', uri: 'x://b' },
                    },
                } as never,
                ctx,
            );
            if (fan.kind !== 'completed') return fan;
            return {
                kind: 'completed',
                output: {
                    ...(fan.output as Record<string, unknown>),
                    render: [
                        { path: 'a.value', ui: 'metric', label: 'A' },
                        { path: 'b.value', ui: 'metric', label: 'B' },
                    ],
                },
            };
        });
        const decl: WorkflowDeclaration = {
            name: 'wf-nested',
            description: 'd',
            version: 1,
            steps: { wrap: { kind: 'subworkflow', ref: 'inner' } },
        };
        const result = await walk(
            'run-nested',
            decl,
            {
                slug: 'wf-nested',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('completed');
        const componentEvents = rig.events.filter(
            (e) => e.type === 'fact.component',
        );
        expect(componentEvents.length).toBe(2);
        expect(componentEvents[0]!.payload).toMatchObject({
            stepId: 'wrap',
            component: { kind: 'metric', props: { label: 'A', value: 1 } },
        });
        expect(componentEvents[1]!.payload).toMatchObject({
            stepId: 'wrap',
            component: { kind: 'metric', props: { label: 'B', value: 2 } },
        });
    });

    it('empty branches map completes with empty output', async () => {
        const rig = makeRig();
        const decl: WorkflowDeclaration = {
            name: 'wf-empty',
            description: 'd',
            version: 1,
            steps: { fan: { kind: 'parallel', branches: {} } },
        };
        const result = await walk(
            'run-empty',
            decl,
            {
                slug: 'wf-empty',
                inputs: {},
                principal: { userId: 'u', scopes: new Set() },
                context: {},
            },
            { ...rig, log: NOOP_LOG },
        );
        expect(result.status).toBe('completed');
        expect(result.outputs.fan).toEqual({});
    });
});
