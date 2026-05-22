import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../event-bus';
import { HitlController, validateAgainstSchema } from '../hitl';
import { InMemoryStore } from '../store/in-memory-store';
import type { FactEvent } from '../types/event';

function makeHitl(): {
    bus: EventBus;
    store: InMemoryStore;
    hitl: HitlController;
    events: FactEvent[];
    seq: { value: number };
} {
    const bus = new EventBus();
    const store = new InMemoryStore();
    const events: FactEvent[] = [];
    const seq = { value: 0 };
    bus.subscribe({ onEvent: (e) => events.push(e) });
    const hitl = new HitlController(bus, store, () => seq.value++);
    return { bus, store, hitl, events, seq };
}

describe('HitlController', () => {
    it('pauseForHuman emits fact.run_paused_human, resume settles the promise', async () => {
        const { hitl, events, store } = makeHitl();
        await store.putRunState({
            runId: 'r-1',
            workflow: 'wf',
            status: 'running',
            inputs: {},
            routing: {},
            startedAt: 0,
        });
        const pausePromise = hitl.pauseForHuman({
            runId: 'r-1',
            stepId: 'step-x',
            schema: {
                type: 'object',
                properties: { choice: { type: 'string', enum: ['a', 'b'] } },
                required: ['choice'],
            },
            prompt: 'Pick',
        });
        // Wait a microtask for the bus emit + state-write to land.
        await Promise.resolve();
        const paused = events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as any).promptId as string;
        expect(typeof promptId).toBe('string');
        // Schema is surfaced via routing.inputSchema for subscribers.
        expect((paused!.routing as any)?.inputSchema).toMatchObject({
            type: 'object',
        });

        await hitl.resume('r-1', {
            promptId,
            value: { choice: 'a' },
        });
        const got = await pausePromise;
        expect(got).toEqual({ choice: 'a' });
        const state = await store.getRunState('r-1');
        // Resume restores 'running' (the walker decides terminal state).
        expect(state?.status).toBe('running');
        const resumed = events.find((e) => e.type === 'fact.run_resumed');
        expect(resumed).toBeDefined();
    });

    it('resume rejects values that fail schema validation', async () => {
        const { hitl, events } = makeHitl();
        hitl.pauseForHuman({
            runId: 'r-1',
            stepId: 's',
            schema: {
                type: 'object',
                properties: { choice: { type: 'string', enum: ['a'] } },
                required: ['choice'],
            },
            prompt: 'Pick',
        });
        await Promise.resolve();
        const promptId = (
            events.find((e) => e.type === 'fact.run_paused_human')!
                .payload as any
        ).promptId as string;
        await expect(
            hitl.resume('r-1', {
                promptId,
                value: { choice: 'nope' },
            }),
        ).rejects.toThrow(/not in enum/);
    });

    it('resume throws on unknown prompt id', async () => {
        const { hitl } = makeHitl();
        await expect(
            hitl.resume('r-1', { promptId: 'nope', value: 'x' }),
        ).rejects.toThrow(/no pending HITL/);
    });

    it('abortPending settles outstanding pauses with rejection', async () => {
        const { hitl } = makeHitl();
        const p = hitl.pauseForHuman({
            runId: 'r-1',
            stepId: 's',
            schema: { type: 'string' },
            prompt: 'pick',
        });
        const handled = vi.fn();
        p.catch(handled);
        hitl.abortPending('r-1', 'cancelled');
        await new Promise((r) => setImmediate(r));
        expect(handled).toHaveBeenCalled();
        expect((handled.mock.calls[0]![0] as Error).message).toMatch(
            /cancelled/,
        );
    });
});

describe('validateAgainstSchema', () => {
    it('accepts a string in an enum', () => {
        expect(
            validateAgainstSchema('a', { type: 'string', enum: ['a', 'b'] }),
        ).toBeNull();
    });
    it('rejects a string outside an enum', () => {
        expect(
            validateAgainstSchema('z', { type: 'string', enum: ['a', 'b'] }),
        ).toMatch(/not in enum/);
    });
    it('checks required object fields', () => {
        expect(
            validateAgainstSchema(
                {},
                {
                    type: 'object',
                    properties: { x: { type: 'string' } },
                    required: ['x'],
                },
            ),
        ).toMatch(/missing required/);
    });
    it('recurses into properties', () => {
        expect(
            validateAgainstSchema(
                { x: 3 },
                {
                    type: 'object',
                    properties: { x: { type: 'string' } },
                },
            ),
        ).toMatch(/x: expected string/);
    });
    it('accepts numbers and booleans by type', () => {
        expect(validateAgainstSchema(3, { type: 'number' })).toBeNull();
        expect(validateAgainstSchema(true, { type: 'boolean' })).toBeNull();
        expect(validateAgainstSchema('x', { type: 'number' })).toMatch(
            /expected number/,
        );
    });
});
