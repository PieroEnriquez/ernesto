/**
 * Tests for the bundled-UI middleware. The middleware lets opt-in MCP
 * tools fold a `ui?: UiComponent[]` field into their input args — the
 * dispatch wrapper validates + emits each component before the handler
 * runs, and strips `ui` so the handler only sees its own input shape.
 */

import { describe, it, expect, vi } from 'vitest';
import { extractAndEmitBundledUi } from '../bundled-ui';
import type { UiComponent } from '../../components/types';
import { EventBus } from '../../workflow-engine/event-bus';
import { InMemoryStore } from '../../workflow-engine/store/in-memory-store';
import { HitlController } from '../../workflow-engine/hitl';
import type { FactEvent } from '../../workflow-engine/types/event';
import type { UiHitlPauser } from '../types';

function makeCtx(opts?: { hitl?: UiHitlPauser }) {
    const emitted: { type: 'fact.component'; component: UiComponent }[] = [];
    const warnings: { msg: string; meta?: unknown }[] = [];
    const ctx = {
        emit: (ev: { type: 'fact.component'; component: UiComponent }) =>
            emitted.push(ev),
        log: {
            warn: (msg: string, meta?: unknown) => warnings.push({ msg, meta }),
        },
        ...(opts?.hitl
            ? { hitl: opts.hitl, runId: 'r-1', stepId: 's-1' }
            : {}),
    };
    return { ctx, emitted, warnings };
}

describe('extractAndEmitBundledUi — no-op cases', () => {
    it('passes through args unchanged when `ui` is absent', async () => {
        const { ctx, emitted } = makeCtx();
        const args = { uri: 'test://x', params: { a: 1 } };
        const result = await extractAndEmitBundledUi(args, ctx);
        expect(result.cleanedArgs).toEqual(args);
        expect(result.emittedCount).toBe(0);
        expect(result.skippedCount).toBe(0);
        expect(emitted).toHaveLength(0);
    });

    it('strips an empty `ui: []` and emits nothing', async () => {
        const { ctx, emitted } = makeCtx();
        const args = { uri: 'test://x', ui: [] };
        const result = await extractAndEmitBundledUi(args, ctx);
        expect(result.cleanedArgs).not.toHaveProperty('ui');
        expect(result.cleanedArgs).toEqual({ uri: 'test://x' });
        expect(result.emittedCount).toBe(0);
        expect(emitted).toHaveLength(0);
    });
});

describe('extractAndEmitBundledUi — emission', () => {
    it('emits a single valid status component and strips `ui`', async () => {
        const { ctx, emitted } = makeCtx();
        const status: UiComponent = {
            kind: 'status',
            props: { text: 'Querying…', level: 'progress' },
        };
        const result = await extractAndEmitBundledUi(
            { uri: 'test://x', params: {}, ui: [status] },
            ctx,
        );
        expect(result.emittedCount).toBe(1);
        expect(result.skippedCount).toBe(0);
        expect(result.cleanedArgs).toEqual({ uri: 'test://x', params: {} });
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
            type: 'fact.component',
            component: { kind: 'status', props: { text: 'Querying…' } },
        });
    });

    it('emits multiple components in order', async () => {
        const { ctx, emitted } = makeCtx();
        const ui: UiComponent[] = [
            { kind: 'thinking', props: { text: 'reasoning' } },
            { kind: 'status', props: { text: 'go' } },
            { kind: 'progress', props: { label: 'p', current: 1, total: 3 } },
        ];
        const result = await extractAndEmitBundledUi(
            { uri: 'test://x', ui },
            ctx,
        );
        expect(result.emittedCount).toBe(3);
        expect(emitted.map((e) => e.component.kind)).toEqual([
            'thinking',
            'status',
            'progress',
        ]);
    });

    it('skips invalid components but emits the valid ones', async () => {
        const { ctx, emitted, warnings } = makeCtx();
        const ui: unknown[] = [
            { kind: 'status', props: { text: 'ok' } },
            { kind: 'bogus-kind', props: {} },
            { kind: 'thinking', props: { text: 'still here' } },
        ];
        const result = await extractAndEmitBundledUi(
            { uri: 'test://x', ui },
            ctx,
        );
        expect(result.emittedCount).toBe(2);
        expect(result.skippedCount).toBe(1);
        expect(emitted).toHaveLength(2);
        expect(emitted.map((e) => e.component.kind)).toEqual([
            'status',
            'thinking',
        ]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0].msg).toContain('skipping invalid component');
    });
});

describe('extractAndEmitBundledUi — HITL pause', () => {
    it('emits AND pauses on a `hitl` with expect.kind=choice when hitl ctx is present', async () => {
        const bus = new EventBus();
        const store = new InMemoryStore();
        let seq = 0;
        const events: FactEvent[] = [];
        bus.subscribe({ onEvent: (e) => events.push(e) });
        const hitl = new HitlController(bus, store, () => seq++);
        await store.putRunState({
            runId: 'r-1',
            workflow: 'wf',
            status: 'running',
            inputs: {},
            routing: {},
            startedAt: Date.now(),
        });

        const emitted: { type: 'fact.component'; component: UiComponent }[] =
            [];
        const ctx = {
            emit: (ev: { type: 'fact.component'; component: UiComponent }) =>
                emitted.push(ev),
            log: { warn: vi.fn() },
            hitl,
            runId: 'r-1',
            stepId: 's-1',
        };

        const ui: UiComponent[] = [
            { kind: 'status', props: { text: 'asking' } },
            {
                kind: 'hitl',
                props: {
                    render: [{ kind: 'markdown', props: { body: 'pick one' } }],
                    expect: { kind: 'choice', schema: { enum: ['a', 'b'] } },
                    resumePrompt: 'picked {value}',
                },
            },
        ];

        const pending = extractAndEmitBundledUi(
            { uri: 'test://x', ui },
            ctx,
        );

        // Yield to the pause flow.
        await new Promise((r) => setImmediate(r));
        // Both components should be emitted before the pause settles.
        expect(emitted).toHaveLength(2);
        expect(emitted.map((e) => e.component.kind)).toEqual([
            'status',
            'hitl',
        ]);
        const paused = events.find((e) => e.type === 'fact.run_paused_human');
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await hitl.resume('r-1', { promptId, value: 'b' });
        const result = await pending;
        expect(result.hitlResponse).toBe('b');
        expect(result.emittedCount).toBe(2);
        expect(result.skippedCount).toBe(0);
    });

    it('does NOT call hitl.pauseForHuman for hitl with expect.kind=message', async () => {
        const pause = vi.fn();
        const { ctx, emitted } = makeCtx({
            hitl: { pauseForHuman: pause } as unknown as UiHitlPauser,
        });
        const ui: UiComponent[] = [
            {
                kind: 'hitl',
                props: {
                    render: [],
                    expect: { kind: 'message' },
                    resumePrompt: 'follow-up?',
                },
            },
        ];
        const result = await extractAndEmitBundledUi(
            { uri: 'test://x', ui },
            ctx,
        );
        expect(pause).not.toHaveBeenCalled();
        expect(result.emittedCount).toBe(1);
        expect(emitted).toHaveLength(1);
        expect(emitted[0].component.kind).toBe('hitl');
        expect(result.hitlResponse).toBeUndefined();
    });

    it('emits hitl but skips pause + logs warn when ctx.hitl is absent', async () => {
        const { ctx, emitted, warnings } = makeCtx(); // no hitl
        const ui: UiComponent[] = [
            {
                kind: 'hitl',
                props: {
                    render: [],
                    expect: { kind: 'choice', schema: { enum: ['x', 'y'] } },
                    resumePrompt: 'pick {value}',
                },
            },
        ];
        const result = await extractAndEmitBundledUi(
            { uri: 'test://x', ui },
            ctx,
        );
        expect(result.emittedCount).toBe(1);
        expect(emitted).toHaveLength(1);
        expect(emitted[0].component.kind).toBe('hitl');
        expect(result.hitlResponse).toBeUndefined();
        // One warn about the missing hitl context.
        expect(warnings.some((w) => w.msg.includes('no hitl context'))).toBe(
            true,
        );
    });
});
