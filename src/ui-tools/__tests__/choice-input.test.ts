import { describe, it, expect } from 'vitest';
import { handleChoiceInput } from '../tool-handlers/choice-input';
import { handleTextInput } from '../tool-handlers/text-input';
import { handleForm } from '../tool-handlers/form';
import { EventBus } from '../../workflow-engine/event-bus';
import { InMemoryStore } from '../../workflow-engine/store/in-memory-store';
import { HitlController } from '../../workflow-engine/hitl';
import type { FactEvent } from '../../workflow-engine/types/event';
import type { UiToolContext } from '../types';

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

describe('ui.choice_input handler', () => {
    it('emits fact.component AND pauses; resume returns the user choice', async () => {
        const rig = makeRig();

        const pending = handleChoiceInput(
            {
                prompt: 'Pick one',
                choices: [
                    { value: 'a', label: 'A' },
                    { value: 'b', label: 'B' },
                ],
            },
            rig.ctx,
        );

        // The handler MUST have emitted the component synchronously
        // before awaiting the pause.
        expect(rig.emitted).toHaveLength(1);
        expect(rig.emitted[0]).toMatchObject({
            type: 'fact.component',
            component: { kind: 'choice_input' },
        });
        // slotId auto-generated when caller didn't pass one.
        expect(rig.emitted[0].component.slotId).toBeTypeOf('string');

        // Wait for pause + putRunState side effects.
        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as { promptId: string }).promptId;

        await rig.hitl.resume('r-1', {
            promptId,
            value: { choice: 'b' },
        });

        const result = await pending;
        expect(result).toBe('b');
    });

    it('multi: true returns an array', async () => {
        const rig = makeRig();
        const pending = handleChoiceInput(
            {
                prompt: 'Pick many',
                multi: true,
                choices: [
                    { value: 'a', label: 'A' },
                    { value: 'b', label: 'B' },
                    { value: 'c', label: 'C' },
                ],
            },
            rig.ctx,
        );
        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await rig.hitl.resume('r-1', {
            promptId,
            value: { choices: ['a', 'c'] },
        });
        const result = await pending;
        expect(result).toEqual(['a', 'c']);
    });

    it('honors a caller-provided slotId', async () => {
        const rig = makeRig();
        const pending = handleChoiceInput(
            {
                prompt: 'p',
                slotId: 'fixed-slot',
                choices: [{ value: 'a', label: 'A' }],
            } as any,
            rig.ctx,
        );
        expect(rig.emitted[0].component.slotId).toBe('fixed-slot');
        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await rig.hitl.resume('r-1', {
            promptId,
            value: { choice: 'a' },
        });
        await pending;
    });
});

describe('ui.text_input handler', () => {
    it('emits + pauses + returns the unwrapped value', async () => {
        const rig = makeRig();
        const pending = handleTextInput(
            { prompt: 'Your name?' },
            rig.ctx,
        );
        expect(rig.emitted[0].component.kind).toBe('text_input');
        await new Promise((r) => setImmediate(r));
        const paused = rig.events.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await rig.hitl.resume('r-1', {
            promptId,
            value: { value: 'Ada' },
        });
        const result = await pending;
        expect(result).toBe('Ada');
    });
});

describe('ui.form handler', () => {
    it('emits + pauses + returns the submitted form data', async () => {
        const rig = makeRig();
        const pending = handleForm(
            {
                prompt: 'Sign up',
                fields: [
                    { id: 'name', label: 'Name', type: 'string', required: true },
                    { id: 'age', label: 'Age', type: 'number' },
                    {
                        id: 'role',
                        label: 'Role',
                        type: 'choice',
                        options: ['admin', 'user'],
                    },
                ],
            },
            rig.ctx,
        );
        expect(rig.emitted[0].component.kind).toBe('form');
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
});
