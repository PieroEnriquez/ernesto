import { describe, it, expect } from 'vitest';
import {
    validateUiComponent,
    validateThinking,
    validateStatus,
    validateProgress,
    validateAttachment,
    validateHitl,
    validateRenderableComponent,
} from '../validation';

describe('validateUiComponent — dispatch', () => {
    it('rejects non-objects', () => {
        expect(validateUiComponent(null).ok).toBe(false);
        expect(validateUiComponent('hi').ok).toBe(false);
        expect(validateUiComponent(42).ok).toBe(false);
    });

    it('rejects unknown kinds', () => {
        const r = validateUiComponent({ kind: 'bogus', props: {} });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/not a top-level UiComponent kind/);
    });

    it('rejects renderable kinds at the top level', () => {
        const r = validateUiComponent({
            kind: 'markdown',
            props: { body: 'x' },
        });
        expect(r.ok).toBe(false);
    });

    it('routes thinking through validateThinking', () => {
        const r = validateUiComponent({
            kind: 'thinking',
            props: { text: 'reasoning' },
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.kind).toBe('thinking');
    });
});

describe('validateThinking', () => {
    it('accepts the happy path', () => {
        const r = validateThinking({
            kind: 'thinking',
            props: { text: 'reasoning…' },
            slotId: 'sl',
        });
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value.slotId).toBe('sl');
    });

    it('rejects empty text', () => {
        const r = validateThinking({ kind: 'thinking', props: { text: '' } });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toMatch(/non-empty string/);
            // Shape hint should be present.
            expect(r.error).toContain('Try:');
            expect(r.error).toMatch(/kind: 'thinking'/);
        }
    });

    it('rejects wrong kind', () => {
        const r = validateThinking({ kind: 'status', props: { text: 'x' } });
        expect(r.ok).toBe(false);
    });
});

describe('validateStatus', () => {
    it('accepts level=undefined', () => {
        const r = validateStatus({ kind: 'status', props: { text: 'syncing' } });
        expect(r.ok).toBe(true);
    });

    it('accepts each valid level', () => {
        for (const level of ['info', 'progress', 'success', 'warn', 'error']) {
            const r = validateStatus({
                kind: 'status',
                props: { text: 't', level },
            });
            expect(r.ok).toBe(true);
        }
    });

    it('rejects invalid level', () => {
        const r = validateStatus({
            kind: 'status',
            props: { text: 't', level: 'bad' },
        });
        expect(r.ok).toBe(false);
    });
});

describe('validateProgress', () => {
    it('accepts the happy path', () => {
        const r = validateProgress({
            kind: 'progress',
            props: { label: 'sync', current: 3, total: 10 },
        });
        expect(r.ok).toBe(true);
    });

    it('rejects non-finite numbers', () => {
        const r = validateProgress({
            kind: 'progress',
            props: { label: 'sync', current: Infinity, total: 10 },
        });
        expect(r.ok).toBe(false);
    });

    it('rejects missing label', () => {
        const r = validateProgress({
            kind: 'progress',
            props: { current: 1, total: 10 },
        });
        expect(r.ok).toBe(false);
    });
});

describe('validateAttachment', () => {
    it('accepts path-only', () => {
        const r = validateAttachment({
            kind: 'attachment',
            props: { filename: 'r.json', path: '_results/r.json' },
        });
        expect(r.ok).toBe(true);
    });

    it('accepts url-only', () => {
        const r = validateAttachment({
            kind: 'attachment',
            props: { filename: 'pic.png', url: 'https://e/x.png' },
        });
        expect(r.ok).toBe(true);
    });

    it('rejects when neither path nor url is present', () => {
        const r = validateAttachment({
            kind: 'attachment',
            props: { filename: 'r.json' },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/path, url/);
    });

    it('rejects empty filename', () => {
        const r = validateAttachment({
            kind: 'attachment',
            props: { filename: '', path: 'x' },
        });
        expect(r.ok).toBe(false);
    });
});

describe('validateHitl', () => {
    it('accepts a hitl with valid render + expect=message', () => {
        const r = validateHitl({
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'hi' } }],
                expect: { kind: 'message' },
                resumePrompt: 'continue?',
            },
        });
        expect(r.ok).toBe(true);
    });

    it('accepts expect=choice with enum schema', () => {
        const r = validateHitl({
            kind: 'hitl',
            props: {
                render: [],
                expect: { kind: 'choice', schema: { enum: ['a', 'b'] } },
                resumePrompt: 'pick {value}',
            },
        });
        expect(r.ok).toBe(true);
    });

    it('accepts expect=form with object schema', () => {
        const r = validateHitl({
            kind: 'hitl',
            props: {
                render: [],
                expect: {
                    kind: 'form',
                    schema: { type: 'object', properties: { name: { type: 'string' } } },
                },
                resumePrompt: 'submitted {value}',
            },
        });
        expect(r.ok).toBe(true);
    });

    it('rejects an invalid nested render at the bad index', () => {
        const r = validateHitl({
            kind: 'hitl',
            props: {
                render: [
                    { kind: 'markdown', props: { body: 'ok' } },
                    { kind: 'bogus', props: {} },
                ],
                expect: { kind: 'message' },
                resumePrompt: 'p',
            },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/hitl\.props\.render\[1\]/);
    });

    it('rejects hitl with no resumePrompt', () => {
        const r = validateHitl({
            kind: 'hitl',
            props: {
                render: [],
                expect: { kind: 'message' },
            },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            // Hint that the field is REQUIRED and how it's used.
            expect(r.error).toMatch(/resumePrompt is required/);
            expect(r.error).toMatch(/Don't omit it/);
        }
    });

    it('rejects expect=choice with no enum', () => {
        const r = validateHitl({
            kind: 'hitl',
            props: {
                render: [],
                expect: { kind: 'choice', schema: {} },
                resumePrompt: 'p',
            },
        });
        expect(r.ok).toBe(false);
    });

    it('accepts nextSteps as strings and structured objects', () => {
        const r = validateHitl({
            kind: 'hitl',
            props: {
                render: [],
                expect: { kind: 'none' },
                resumePrompt: 'next',
                nextSteps: ['retry', { id: 'go', label: 'Go' }],
            },
        });
        expect(r.ok).toBe(true);
    });

    it('rejects malformed nextStep object', () => {
        const r = validateHitl({
            kind: 'hitl',
            props: {
                render: [],
                expect: { kind: 'none' },
                resumePrompt: 'p',
                nextSteps: [{ label: 'no id' }],
            },
        });
        expect(r.ok).toBe(false);
    });
});

describe('validateRenderableComponent', () => {
    it('rejects top-level kinds (e.g. hitl)', () => {
        const r = validateRenderableComponent({
            kind: 'hitl',
            props: {
                render: [],
                expect: { kind: 'message' },
                resumePrompt: 'p',
            },
        });
        expect(r.ok).toBe(false);
    });

    it('rejects top-level status', () => {
        const r = validateRenderableComponent({
            kind: 'status',
            props: { text: 'x' },
        });
        expect(r.ok).toBe(false);
    });

    it('accepts markdown', () => {
        const r = validateRenderableComponent({
            kind: 'markdown',
            props: { body: '## hi' },
        });
        expect(r.ok).toBe(true);
    });

    it('accepts data-ref', () => {
        const r = validateRenderableComponent({
            kind: 'data-ref',
            props: { file: 'data/x.json', view: 'table', caption: 'X' },
        });
        expect(r.ok).toBe(true);
    });

    it('rejects data-ref missing file', () => {
        const r = validateRenderableComponent({
            kind: 'data-ref',
            props: { view: 'table' },
        });
        expect(r.ok).toBe(false);
    });

    it('accepts file-link', () => {
        const r = validateRenderableComponent({
            kind: 'file-link',
            props: { path: 'doc.md', label: 'open' },
        });
        expect(r.ok).toBe(true);
    });

    it('rejects file-link missing path', () => {
        const r = validateRenderableComponent({
            kind: 'file-link',
            props: { label: 'oops' },
        });
        expect(r.ok).toBe(false);
    });

    it('accepts table with valid columns', () => {
        const r = validateRenderableComponent({
            kind: 'table',
            props: {
                columns: [{ id: 'a', label: 'A', align: 'right' }],
                rows: [{ a: 1 }],
                caption: 'T',
            },
        });
        expect(r.ok).toBe(true);
    });

    it('rejects table column with bad align', () => {
        const r = validateRenderableComponent({
            kind: 'table',
            props: {
                columns: [{ id: 'a', label: 'A', align: 'middle' }],
                rows: [],
            },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toContain('Try:');
    });

    it('rejects table column passed as a bare string with a useful hint', () => {
        const r = validateRenderableComponent({
            kind: 'table',
            props: { columns: ['Region', 'GMV'], rows: [] },
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toMatch(/must be \{id: string, label: string\}/);
            expect(r.error).toContain("Try:");
            expect(r.error).toMatch(/id: 'region'/);
        }
    });

    it('hints the recovery shape on markdown.props as a bare string', () => {
        const r = validateRenderableComponent({
            kind: 'markdown',
            props: 'just the body',
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toMatch(/must be \{body: string\}/);
            expect(r.error).toContain('Try:');
        }
    });

    it('accepts metric with optional delta', () => {
        const r = validateRenderableComponent({
            kind: 'metric',
            props: {
                label: 'orders',
                value: 42,
                unit: 'count',
                delta: { value: 0.1, direction: 'up', period: '7d' },
            },
        });
        expect(r.ok).toBe(true);
    });

    it('rejects metric with non-numeric delta.value', () => {
        const r = validateRenderableComponent({
            kind: 'metric',
            props: {
                label: 'orders',
                value: 42,
                delta: { value: 'x', direction: 'up' },
            },
        });
        expect(r.ok).toBe(false);
    });

    it('accepts code with caption', () => {
        const r = validateRenderableComponent({
            kind: 'code',
            props: { body: 'x', language: 'ts', caption: 'snippet' },
        });
        expect(r.ok).toBe(true);
    });

    it('accepts image / link / tree happy paths', () => {
        expect(
            validateRenderableComponent({
                kind: 'image',
                props: { url: 'https://e/x.png', alt: 'x' },
            }).ok,
        ).toBe(true);
        expect(
            validateRenderableComponent({
                kind: 'link',
                props: { url: 'https://e', title: 'Open' },
            }).ok,
        ).toBe(true);
        expect(
            validateRenderableComponent({
                kind: 'tree',
                props: { nodes: [{ label: 'r' }] },
            }).ok,
        ).toBe(true);
    });

    it('rejects unknown renderable kind', () => {
        const r = validateRenderableComponent({ kind: 'bogus', props: {} });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toMatch(/not a RenderableComponent kind/);
    });
});
