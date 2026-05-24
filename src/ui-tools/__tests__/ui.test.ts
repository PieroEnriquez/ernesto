/**
 * Tests for the unified `ui` MCP tool dispatcher. The handler accepts
 * a single UiComponent or an array; validates each; emits one
 * `fact.component` per valid entry; pauses on `hitl` with
 * `expect.kind ∈ {'choice', 'form'}`.
 */

import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleUi } from '../tool-handlers/ui';
import type { UiComponent } from '../../components/types';
import { EventBus } from '../../workflow-engine/event-bus';
import { InMemoryStore } from '../../workflow-engine/store/in-memory-store';
import { HitlController } from '../../workflow-engine/hitl';
import type { FactEvent } from '../../workflow-engine/types/event';
import type { UiToolContext, UiHitlPauser } from '../types';

function makeCtx(): { ctx: UiToolContext; emitted: any[] } {
    const emitted: any[] = [];
    const ctx: UiToolContext = {
        runId: 'r-1',
        stepId: 's-1',
        emit: (ev) => emitted.push(ev),
        hitl: {} as UiHitlPauser,
    };
    return { ctx, emitted };
}

const SAMPLES: UiComponent[] = [
    { kind: 'thinking', props: { text: 'reasoning…' } },
    { kind: 'status', props: { text: 'fetching', level: 'progress' } },
    {
        kind: 'progress',
        props: { label: 'sync', current: 1, total: 10 },
    },
    {
        kind: 'attachment',
        props: { filename: 'r.json', path: '_results/r.json' },
    },
];

describe('handleUi — unified dispatcher (single component)', () => {
    for (const sample of SAMPLES) {
        it(`emits fact.component for kind=${sample.kind}`, async () => {
            const { ctx, emitted } = makeCtx();
            const result = await handleUi(sample, ctx);
            expect(emitted).toHaveLength(1);
            expect(emitted[0]).toMatchObject({
                type: 'fact.component',
                component: { kind: sample.kind, props: sample.props },
            });
            expect(result).toEqual({ ok: true });
        });
    }

    it('emits a hitl with expect=message and returns ok (no pause)', async () => {
        const { ctx, emitted } = makeCtx();
        const result = await handleUi(
            {
                kind: 'hitl',
                props: {
                    render: [{ kind: 'markdown', props: { body: 'done' } }],
                    expect: { kind: 'message' },
                    resumePrompt: 'follow up?',
                },
            },
            ctx,
        );
        expect(emitted).toHaveLength(1);
        expect(emitted[0].component.kind).toBe('hitl');
        expect(result).toEqual({ ok: true });
    });
});

describe('handleUi — array of components (bulk emit)', () => {
    it('emits each entry in order', async () => {
        const { ctx, emitted } = makeCtx();
        const result = await handleUi(
            [
                { kind: 'status', props: { text: 'a' } },
                { kind: 'thinking', props: { text: 'b' } },
            ],
            ctx,
        );
        expect(emitted).toHaveLength(2);
        expect(emitted[0].component.kind).toBe('status');
        expect(emitted[1].component.kind).toBe('thinking');
        expect(result).toEqual({ ok: true });
    });

    it('reports per-component errors and emits nothing on any failure', async () => {
        const { ctx, emitted } = makeCtx();
        const result = await handleUi(
            [
                { kind: 'status', props: { text: 'ok' } },
                { kind: 'bogus', props: {} } as unknown as UiComponent,
            ],
            ctx,
        );
        expect(emitted).toHaveLength(0);
        expect((result as { ok: boolean }).ok).toBe(false);
        const errors = (result as { errors: { index: number }[] }).errors;
        expect(errors).toHaveLength(1);
        expect(errors[0].index).toBe(1);
    });
});

describe('handleUi — hitl pause contract', () => {
    it('pauses on hitl with expect.kind=choice and returns the human response', async () => {
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
        const ctx: UiToolContext = {
            runId: 'r-1',
            stepId: 's-1',
            emit: () => undefined,
            hitl,
        };
        const pending = handleUi(
            {
                kind: 'hitl',
                props: {
                    render: [{ kind: 'markdown', props: { body: 'pick' } }],
                    expect: { kind: 'choice', schema: { enum: ['a', 'b'] } },
                    resumePrompt: 'picked {value}',
                },
            },
            ctx,
        );
        await new Promise((r) => setImmediate(r));
        const paused = events.find((e) => e.type === 'fact.run_paused_human');
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await hitl.resume('r-1', { promptId, value: 'b' });
        expect(await pending).toBe('b');
    });

    it('pauses on hitl with expect.kind=form and returns the submitted object', async () => {
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
        const ctx: UiToolContext = {
            runId: 'r-1',
            stepId: 's-1',
            emit: () => undefined,
            hitl,
        };
        const pending = handleUi(
            {
                kind: 'hitl',
                props: {
                    render: [],
                    expect: {
                        kind: 'form',
                        schema: {
                            type: 'object',
                            properties: { name: { type: 'string' } },
                        },
                    },
                    resumePrompt: 'submitted',
                },
            },
            ctx,
        );
        await new Promise((r) => setImmediate(r));
        const paused = events.find((e) => e.type === 'fact.run_paused_human');
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await hitl.resume('r-1', { promptId, value: { name: 'Ada' } });
        expect(await pending).toEqual({ name: 'Ada' });
    });

    it('does NOT call hitl.pauseForHuman for hitl with expect.kind=message', async () => {
        const pause = vi.fn();
        const ctx: UiToolContext = {
            runId: 'r',
            stepId: 's',
            emit: () => undefined,
            hitl: { pauseForHuman: pause } as unknown as UiHitlPauser,
        };
        await handleUi(
            {
                kind: 'hitl',
                props: {
                    render: [],
                    expect: { kind: 'message' },
                    resumePrompt: 'p',
                },
            },
            ctx,
        );
        expect(pause).not.toHaveBeenCalled();
    });

    it('does NOT pause for non-hitl kinds', async () => {
        const pause = vi.fn();
        const ctx: UiToolContext = {
            runId: 'r',
            stepId: 's',
            emit: () => undefined,
            hitl: { pauseForHuman: pause } as unknown as UiHitlPauser,
        };
        await handleUi(
            { kind: 'status', props: { text: 'ok' } },
            ctx,
        );
        expect(pause).not.toHaveBeenCalled();
    });
});

describe('handleUi — ref shape (workdir file)', () => {
    function makeWorkdir(): string {
        return mkdtempSync(join(tmpdir(), 'ui-ref-test-'));
    }

    it('reads { component: [...] } from a workdir-relative file and emits each component', async () => {
        const wd = makeWorkdir();
        mkdirSync(join(wd, '_ui'));
        writeFileSync(
            join(wd, '_ui', 'turn.json'),
            JSON.stringify({
                component: [
                    { kind: 'status', props: { text: 'a' } },
                    { kind: 'progress', props: { label: 'x', current: 1, total: 4 } },
                ],
            }),
            'utf8',
        );
        const { ctx, emitted } = makeCtx();
        ctx.workdirRoot = wd;
        const result = await handleUi({ ref: '_ui/turn.json' }, ctx);
        expect(result).toEqual({ ok: true });
        expect(emitted).toHaveLength(2);
        expect(emitted[0].component.kind).toBe('status');
        expect(emitted[1].component.kind).toBe('progress');
        rmSync(wd, { recursive: true, force: true });
    });

    it('accepts a single-object component field (not just an array)', async () => {
        const wd = makeWorkdir();
        writeFileSync(
            join(wd, 'one.json'),
            JSON.stringify({
                component: { kind: 'status', props: { text: 'only' } },
            }),
            'utf8',
        );
        const { ctx, emitted } = makeCtx();
        ctx.workdirRoot = wd;
        const result = await handleUi({ ref: 'one.json' }, ctx);
        expect(result).toEqual({ ok: true });
        expect(emitted).toHaveLength(1);
        rmSync(wd, { recursive: true, force: true });
    });

    it('returns per-component errors with ref + jsonPath on validation failure', async () => {
        const wd = makeWorkdir();
        mkdirSync(join(wd, '_ui'));
        writeFileSync(
            join(wd, '_ui', 'broken.json'),
            JSON.stringify({
                component: [
                    { kind: 'status', props: { text: 'ok' } },
                    { kind: 'attachment', props: {} }, // missing path/url
                ],
            }),
            'utf8',
        );
        const { ctx } = makeCtx();
        ctx.workdirRoot = wd;
        const result = (await handleUi({ ref: '_ui/broken.json' }, ctx)) as {
            ok: boolean;
            errors: { index: number; errors: string[]; ref?: string; jsonPath?: string }[];
        };
        expect(result.ok).toBe(false);
        const failing = result.errors.find((e) => e.index === 1)!;
        expect(failing).toBeDefined();
        expect(failing.ref).toBe('_ui/broken.json');
        expect(failing.jsonPath).toBe('/component/1');
        expect(failing.errors.length).toBeGreaterThan(0);
        rmSync(wd, { recursive: true, force: true });
    });

    it('rejects refs with parent segments before reading anything', async () => {
        const { ctx } = makeCtx();
        ctx.workdirRoot = makeWorkdir();
        const result = (await handleUi({ ref: '../escape.json' }, ctx)) as {
            ok: boolean;
            errors: { errors: string[] }[];
        };
        expect(result.ok).toBe(false);
        expect(result.errors[0].errors[0]).toMatch(/parent segment/);
        rmSync(ctx.workdirRoot!, { recursive: true, force: true });
    });

    it('fails with ref_unsupported when no workdir is bound', async () => {
        const { ctx } = makeCtx();
        // No workdirRoot set.
        const result = (await handleUi({ ref: '_ui/turn.json' }, ctx)) as {
            ok: boolean;
            errors: { errors: string[] }[];
        };
        expect(result.ok).toBe(false);
        expect(result.errors[0].errors[0]).toMatch(/ref is not supported/);
    });

    it('reports not_found for refs pointing to a missing file', async () => {
        const wd = makeWorkdir();
        const { ctx } = makeCtx();
        ctx.workdirRoot = wd;
        const result = (await handleUi({ ref: 'absent.json' }, ctx)) as {
            ok: boolean;
            errors: { errors: string[] }[];
        };
        expect(result.ok).toBe(false);
        expect(result.errors[0].errors[0]).toMatch(/not found/);
        rmSync(wd, { recursive: true, force: true });
    });
});

describe('handleUi — attachment transformer hook', () => {
    it('rewrites the emitted component when transformer succeeds', async () => {
        const { ctx, emitted } = makeCtx();
        ctx.transformAttachment = async (c) => ({
            ok: true,
            component: {
                ...c,
                props: {
                    ...c.props,
                    path: (c.props.path ?? '').replace(/\.svg$/, '.png'),
                    filename: (c.props.filename ?? '').replace(/\.svg$/, '.png'),
                    mimeType: 'image/png',
                },
            },
        });
        const result = await handleUi(
            {
                kind: 'attachment',
                props: {
                    path: 'chart.svg',
                    filename: 'chart.svg',
                    mimeType: 'image/svg+xml',
                },
            },
            ctx,
        );
        expect(result).toEqual({ ok: true });
        expect(emitted).toHaveLength(1);
        expect(emitted[0].component.props.path).toBe('chart.png');
        expect(emitted[0].component.props.mimeType).toBe('image/png');
    });

    it('surfaces transformer errors in the tool result and emits nothing', async () => {
        const { ctx, emitted } = makeCtx();
        ctx.transformAttachment = async () => ({
            ok: false,
            error: 'svg is not valid — missing root <svg> element',
        });
        const result = (await handleUi(
            {
                kind: 'attachment',
                props: {
                    path: 'broken.svg',
                    filename: 'broken.svg',
                    mimeType: 'image/svg+xml',
                },
            },
            ctx,
        )) as { ok: boolean; errors: { index: number; errors: string[] }[] };
        expect(result.ok).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].index).toBe(0);
        expect(result.errors[0].errors[0]).toContain('svg is not valid');
        expect(emitted).toHaveLength(0);
    });

    it('captures unexpected transformer throws without crashing', async () => {
        const { ctx, emitted } = makeCtx();
        ctx.transformAttachment = async () => {
            throw new Error('native panic simulated');
        };
        const result = (await handleUi(
            {
                kind: 'attachment',
                props: { path: 'crash.svg', filename: 'crash.svg' },
            },
            ctx,
        )) as { ok: boolean; errors: { errors: string[] }[] };
        expect(result.ok).toBe(false);
        expect(result.errors[0].errors[0]).toMatch(/transformer threw/);
        expect(result.errors[0].errors[0]).toMatch(/native panic simulated/);
        expect(emitted).toHaveLength(0);
    });

    it('leaves non-attachment components untouched', async () => {
        const { ctx, emitted } = makeCtx();
        let called = 0;
        ctx.transformAttachment = async (c) => {
            called++;
            return { ok: true, component: c };
        };
        await handleUi(
            [
                { kind: 'status', props: { text: 'a' } },
                {
                    kind: 'attachment',
                    props: {
                        path: 'doc.pdf',
                        filename: 'doc.pdf',
                        mimeType: 'application/pdf',
                    },
                },
            ],
            ctx,
        );
        // Only the attachment goes through the hook.
        expect(called).toBe(1);
        expect(emitted).toHaveLength(2);
    });
});
