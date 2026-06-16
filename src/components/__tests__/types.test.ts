import { describe, it, expect } from 'vitest';
import { RENDERABLE_COMPONENT_KINDS } from '../types';
import type { RenderableComponent, RenderableComponentKind } from '../types';
import { validateRenderableComponent } from '../validation';

// NOTE (B14-dedup): the former type-shaped tests in this file
// (expectTypeOf-only discriminator narrowing, structural-construction cases
// whose only runtime assert was `samples.length === KINDS.length`, and the
// brittle `lists exactly N kinds` count-asserts) were removed. Compile-time
// narrowing is enforced by tsgo, not vitest; per-kind RUNTIME behavior is
// covered authoritatively by validation.test.ts + coerce.test.ts.
//
// The ONE behavior validation.test.ts did NOT already enumerate was the
// `chart` renderable kind, so we retain a single it.each that round-trips
// EVERY renderable kind through validateRenderableComponent — this closes the
// `chart` gap and keeps the others as cheap, extensible redundancy.

const RENDERABLE_SAMPLES: Record<RenderableComponentKind, RenderableComponent> = {
    markdown: { kind: 'markdown', props: { body: '## hi' } },
    'data-ref': {
        kind: 'data-ref',
        props: { file: 'data/x.json', view: 'table' },
    },
    'file-link': { kind: 'file-link', props: { path: 'r.md', label: 'open' } },
    table: {
        kind: 'table',
        props: { columns: [{ id: 'a', label: 'A' }], rows: [{ a: 1 }] },
    },
    metric: { kind: 'metric', props: { label: 'n', value: 42, unit: 'orders' } },
    chart: {
        kind: 'chart',
        props: { series: [{ name: 's', data: [{ x: 1, y: 2 }] }], chartType: 'line' },
    },
    code: { kind: 'code', props: { body: 'x', language: 'ts' } },
    image: { kind: 'image', props: { url: 'https://e/x.png' } },
    link: { kind: 'link', props: { url: 'https://e', title: 'Open' } },
    tree: { kind: 'tree', props: { nodes: [{ label: 'r' }] } },
    actions: {
        kind: 'actions',
        props: { buttons: [{ label: 'Update', actionId: 'teams_update_task__abc' }] },
    },
};

describe('components/types — renderable taxonomy round-trips validation', () => {
    it.each(RENDERABLE_COMPONENT_KINDS)('renderable kind %s validates as a RenderableComponent', (kind) => {
        const sample = RENDERABLE_SAMPLES[kind];
        expect(sample, `missing sample for kind ${kind}`).toBeDefined();
        expect(validateRenderableComponent(sample).ok).toBe(true);
    });
});
