import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { handleInput } from '../tool-handlers/input';
import { createUiMcpServer } from '../server';
import { EventBus } from '../../workflow-engine/event-bus';
import { InMemoryStore } from '../../workflow-engine/store/in-memory-store';
import { HitlController } from '../../workflow-engine/hitl';
import type { FactEvent } from '../../workflow-engine/types/event';
import type { UiToolContext } from '../types';
import type { UiMcpServerHandle } from '../server';

function makeRig(): {
    ctx: UiToolContext;
    hitl: HitlController;
    events: FactEvent[];
    emitted: any[];
} {
    const bus = new EventBus();
    const store = new InMemoryStore();
    let seq = 0;
    const events: FactEvent[] = [];
    bus.subscribe({ onEvent: (e) => events.push(e) });
    const hitl = new HitlController(bus, store, () => seq++);
    const emitted: any[] = [];
    const ctx: UiToolContext = {
        runId: 'r-1',
        stepId: 's-1',
        emit: (ev) => emitted.push(ev),
        hitl,
    };
    // Seed a run-state row so HitlController.pauseForHuman's
    // putRunState flip lands on something.
    void store.putRunState({
        runId: 'r-1',
        workflow: 'wf',
        status: 'running',
        inputs: {},
        routing: {},
        startedAt: Date.now(),
    });
    return { ctx, hitl, events, emitted };
}

describe('ui.input handler — schema-discriminated', () => {
    it('schema-as-enum-string (old choice_input shape) returns the chosen value', async () => {
        const rig = makeRig();
        const pending = handleInput(
            {
                prompt: 'Pick one',
                schema: { type: 'string', enum: ['a', 'b', 'c'] },
            },
            rig.ctx,
        );

        // Component emitted synchronously before the pause awaits.
        expect(rig.emitted).toHaveLength(1);
        expect(rig.emitted[0]).toMatchObject({
            type: 'fact.component',
            component: {
                kind: 'input',
                props: {
                    prompt: 'Pick one',
                    schema: { type: 'string', enum: ['a', 'b', 'c'] },
                },
            },
        });
        // slotId auto-generated when caller didn't pass one.
        expect(rig.emitted[0].component.slotId).toBeTypeOf('string');

        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await rig.hitl.resume('r-1', { promptId, value: 'b' });

        const result = await pending;
        expect(result).toBe('b');
    });

    it('schema-as-plain-string (old text_input shape) returns the typed text', async () => {
        const rig = makeRig();
        const pending = handleInput(
            {
                prompt: 'Your name?',
                schema: { type: 'string' },
            },
            rig.ctx,
        );
        expect(rig.emitted[0].component.kind).toBe('input');
        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await rig.hitl.resume('r-1', { promptId, value: 'Ada' });
        const result = await pending;
        expect(result).toBe('Ada');
    });

    it('schema-as-object (old form shape) returns the submitted record', async () => {
        const rig = makeRig();
        const pending = handleInput(
            {
                prompt: 'Sign up',
                schema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        age: { type: 'number' },
                        role: { type: 'string', enum: ['admin', 'user'] },
                    },
                    required: ['name'],
                },
            },
            rig.ctx,
        );
        expect(rig.emitted[0].component.kind).toBe('input');
        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await rig.hitl.resume('r-1', {
            promptId,
            value: { name: 'Ada', age: 30, role: 'admin' },
        });
        const result = await pending;
        expect(result).toEqual({ name: 'Ada', age: 30, role: 'admin' });
    });

    it('schema-as-number returns the numeric value', async () => {
        const rig = makeRig();
        const pending = handleInput(
            { prompt: 'How many?', schema: { type: 'number' } },
            rig.ctx,
        );
        expect(rig.emitted[0].component.kind).toBe('input');
        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await rig.hitl.resume('r-1', { promptId, value: 42 });
        const result = await pending;
        expect(result).toBe(42);
    });

    it('honors a caller-provided slotId', async () => {
        const rig = makeRig();
        const pending = handleInput(
            {
                prompt: 'p',
                slotId: 'fixed-slot',
                schema: { type: 'string', enum: ['a'] },
            },
            rig.ctx,
        );
        expect(rig.emitted[0].component.slotId).toBe('fixed-slot');
        // slotId is hoisted out of `props`.
        expect((rig.emitted[0].component.props as any).slotId).toBeUndefined();
        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await rig.hitl.resume('r-1', { promptId, value: 'a' });
        await pending;
    });
});

describe('ui.input — HTTP MCP roundtrip', () => {
    let active: UiMcpServerHandle | undefined;
    afterEach(async () => {
        if (active) {
            await active.close();
            active = undefined;
        }
    });

    async function runMcpRoundtrip(opts: {
        schema: Record<string, unknown>;
        value: unknown;
    }): Promise<string> {
        const bus = new EventBus();
        const store = new InMemoryStore();
        let seq = 0;
        const hitl = new HitlController(bus, store, () => seq++);
        await store.putRunState({
            runId: 'r-1',
            workflow: 'wf',
            status: 'running',
            inputs: {},
            routing: {},
            startedAt: Date.now(),
        });
        const ctx: UiToolContext = {
            runId: 'r-1',
            stepId: 's-1',
            emit: () => undefined,
            hitl,
        };

        const busEvents: any[] = [];
        const sub = await bus.subscribe({
            onEvent: (e) => busEvents.push(e),
        });

        active = await createUiMcpServer({ context: ctx });

        const client = new Client({ name: 'test', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(active.url));
        await client.connect(transport);

        const callPromise = client.callTool({
            name: 'ui.input',
            arguments: { prompt: 'p', schema: opts.schema },
        });

        for (let i = 0; i < 50; i++) {
            if (busEvents.some((e) => e.type === 'fact.run_paused_human')) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        const paused = busEvents.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await hitl.resume('r-1', { promptId, value: opts.value });

        const result = await callPromise;
        const text =
            (result.content as Array<{ type: string; text?: string }>).find(
                (c) => c.type === 'text',
            )?.text ?? '';

        await client.close();
        await sub.close();
        return text;
    }

    it('roundtrips the enum-string shape', async () => {
        const text = await runMcpRoundtrip({
            schema: { type: 'string', enum: ['a', 'b'] },
            value: 'b',
        });
        // The MCP server JSON-stringifies non-string handler outputs;
        // a bare string passes through as-is.
        expect(text).toBe('b');
    });

    it('roundtrips the plain-string shape', async () => {
        const text = await runMcpRoundtrip({
            schema: { type: 'string' },
            value: 'hello',
        });
        expect(text).toBe('hello');
    });

    it('roundtrips the object shape', async () => {
        const text = await runMcpRoundtrip({
            schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
            },
            value: { name: 'Ada' },
        });
        expect(JSON.parse(text)).toEqual({ name: 'Ada' });
    });
});
