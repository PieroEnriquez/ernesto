import { describe, it, expect, expectTypeOf } from 'vitest';
import {
    UI_COMPONENT_KINDS,
    RENDERABLE_COMPONENT_KINDS,
} from '../types';
import type {
    UiComponent,
    UiComponentKind,
    RenderableComponent,
    RenderableComponentKind,
    HitlExpect,
    NextStep,
} from '../types';

describe('components/types — two-level taxonomy', () => {
    it('lists exactly 5 top-level UiComponent kinds', () => {
        expect(UI_COMPONENT_KINDS.length).toBe(5);
        expect(new Set(UI_COMPONENT_KINDS).size).toBe(UI_COMPONENT_KINDS.length);
        for (const kind of [
            'thinking',
            'status',
            'progress',
            'attachment',
            'hitl',
        ] as const) {
            expect(UI_COMPONENT_KINDS).toContain(kind);
        }
        // Old top-level kinds are now renderable-only.
        expect(UI_COMPONENT_KINDS).not.toContain('markdown' as never);
        expect(UI_COMPONENT_KINDS).not.toContain('table' as never);
        // The pre-refactor `input` kind is gone — replaced by
        // hitl.expect.kind = 'choice' | 'form'.
        expect(UI_COMPONENT_KINDS).not.toContain('input' as never);
    });

    it('lists exactly 10 renderable kinds', () => {
        expect(RENDERABLE_COMPONENT_KINDS.length).toBe(10);
        expect(new Set(RENDERABLE_COMPONENT_KINDS).size).toBe(
            RENDERABLE_COMPONENT_KINDS.length,
        );
        for (const kind of [
            'markdown',
            'data-ref',
            'file-link',
            'table',
            'metric',
            'chart',
            'code',
            'image',
            'link',
            'tree',
        ] as const) {
            expect(RENDERABLE_COMPONENT_KINDS).toContain(kind);
        }
        // Top-level kinds are NOT renderable.
        for (const kind of [
            'hitl',
            'thinking',
            'status',
            'progress',
            'attachment',
        ] as const) {
            expect(RENDERABLE_COMPONENT_KINDS).not.toContain(kind as never);
        }
    });

    it('type-level: UiComponent narrows on kind discriminator', () => {
        expectTypeOf<UiComponentKind>().toEqualTypeOf<
            'thinking' | 'status' | 'progress' | 'attachment' | 'hitl'
        >();
        expectTypeOf<RenderableComponentKind>().toEqualTypeOf<
            | 'markdown'
            | 'data-ref'
            | 'file-link'
            | 'table'
            | 'metric'
            | 'chart'
            | 'code'
            | 'image'
            | 'link'
            | 'tree'
        >();
    });

    it('type-level: HitlExpect supports message / choice / form / none', () => {
        const samples: HitlExpect[] = [
            { kind: 'message' },
            { kind: 'choice', schema: { enum: ['a', 'b'] } },
            { kind: 'form', schema: { type: 'object' } },
            { kind: 'none' },
        ];
        expect(samples.length).toBe(4);
    });

    it('type-level: NextStep is string | { id, label }', () => {
        const steps: NextStep[] = ['continue', { id: 'go', label: 'Continue' }];
        expect(steps.length).toBe(2);
    });

    it('type-level: hitl carries a render array of RenderableComponents', () => {
        const hitl: UiComponent = {
            kind: 'hitl',
            props: {
                render: [
                    { kind: 'markdown', props: { body: 'hello' } },
                    { kind: 'metric', props: { label: 'n', value: 42 } },
                ],
                expect: { kind: 'message' },
                resumePrompt: 'Continue?',
            },
        };
        expect(hitl.kind).toBe('hitl');
        if (hitl.kind === 'hitl') {
            expect(hitl.props.render.length).toBe(2);
        }
    });

    it('type-level: every top-level kind constructs structurally', () => {
        const samples: UiComponent[] = [
            { kind: 'thinking', props: { text: 'reasoning' } },
            { kind: 'status', props: { text: 'fetching', level: 'progress' } },
            {
                kind: 'progress',
                props: { label: 'sync', current: 1, total: 10 },
            },
            {
                kind: 'attachment',
                props: { filename: 'r.json', path: '_results/r.json' },
            },
            {
                kind: 'hitl',
                props: {
                    render: [{ kind: 'markdown', props: { body: 'h' } }],
                    expect: { kind: 'message' },
                    resumePrompt: 'follow up?',
                },
            },
        ];
        expect(samples.length).toBe(UI_COMPONENT_KINDS.length);
    });

    it('type-level: every renderable kind constructs structurally', () => {
        const samples: RenderableComponent[] = [
            { kind: 'markdown', props: { body: '## hi' } },
            { kind: 'data-ref', props: { file: 'data/x.json', view: 'table' } },
            { kind: 'file-link', props: { path: 'r.md', label: 'open' } },
            {
                kind: 'table',
                props: {
                    columns: [{ id: 'a', label: 'A' }],
                    rows: [{ a: 1 }],
                },
            },
            { kind: 'metric', props: { label: 'n', value: 42, unit: 'orders' } },
            {
                kind: 'chart',
                props: {
                    series: [{ name: 's', data: [{ x: 1, y: 2 }] }],
                    chartType: 'line',
                },
            },
            { kind: 'code', props: { body: 'x', language: 'ts' } },
            { kind: 'image', props: { url: 'https://e/x.png' } },
            { kind: 'link', props: { url: 'https://e', title: 'Open' } },
            { kind: 'tree', props: { nodes: [{ label: 'r' }] } },
        ];
        expect(samples.length).toBe(RENDERABLE_COMPONENT_KINDS.length);
    });
});
