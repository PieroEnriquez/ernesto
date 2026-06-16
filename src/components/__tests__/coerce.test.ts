import { describe, it, expect } from 'vitest';
import { coerceUiComponent } from '../coerce';
import { validateUiComponent } from '../validation';

describe('coerceUiComponent', () => {
    it('passes a well-formed component through unchanged', () => {
        const c = {
            kind: 'thinking',
            props: { text: 'reasoning…' },
        };
        const out = coerceUiComponent(c);
        // Validator should still accept it.
        expect(validateUiComponent(out).ok).toBe(true);
        // And the well-formed payload should be structurally equal.
        expect(out).toEqual(c);
    });

    it('parses a whole-component JSON-stringified blob', () => {
        const stringified = JSON.stringify({
            kind: 'status',
            props: { text: 'syncing', level: 'progress' },
        });
        const out = coerceUiComponent(stringified);
        expect(validateUiComponent(out).ok).toBe(true);
    });

    it('parses props passed as a JSON string', () => {
        const out = coerceUiComponent({
            kind: 'thinking',
            props: JSON.stringify({ text: 'reasoning' }),
        });
        expect(validateUiComponent(out).ok).toBe(true);
    });

    it('wraps markdown.props bare string into { body }', () => {
        const out = coerceUiComponent({
            kind: 'markdown',
            props: 'the body text',
        });
        // Markdown is a renderable so direct top-level validation won't
        // pass; instead check the coerced shape directly.
        expect((out as Record<string, unknown>).props).toEqual({
            body: 'the body text',
        });
    });

    it('wraps thinking.props bare string into { text }', () => {
        const out = coerceUiComponent({
            kind: 'thinking',
            props: 'just the pill text',
        });
        expect(validateUiComponent(out).ok).toBe(true);
    });

    it('expands table.props.columns from strings to {id,label} objects', () => {
        const out = coerceUiComponent({
            kind: 'table',
            props: {
                columns: ['Region', 'GMV €'],
                rows: [],
            },
        }) as { props: { columns: { id: string; label: string }[] } };
        expect(out.props.columns).toEqual([
            { id: 'region', label: 'Region' },
            { id: 'gmv', label: 'GMV €' },
        ]);
    });

    it('re-slugs an empty column id from its label', () => {
        const out = coerceUiComponent({
            kind: 'table',
            props: {
                columns: [{ id: '', label: 'Region' }],
                rows: [],
            },
        }) as { props: { columns: { id: string; label: string }[] } };
        expect(out.props.columns[0]).toEqual({ id: 'region', label: 'Region' });
    });

    it('recurses into hitl.props.render and coerces each renderable', () => {
        const out = coerceUiComponent({
            kind: 'hitl',
            props: {
                render: [
                    { kind: 'markdown', props: 'just a body' },
                    {
                        kind: 'table',
                        props: { columns: ['Region', 'GMV'], rows: [] },
                    },
                ],
                expect: { kind: 'message' },
                resumePrompt: 'continue',
            },
        });
        const r = validateUiComponent(out);
        expect(r.ok).toBe(true);
    });

    it('returns input unchanged for already-valid hitl', () => {
        const c = {
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'hi' } }],
                expect: { kind: 'message' },
                resumePrompt: 'continue',
            },
        };
        const out = coerceUiComponent(c);
        expect(validateUiComponent(out).ok).toBe(true);
    });

    it('does not throw on non-object, non-string inputs', () => {
        expect(() => coerceUiComponent(null)).not.toThrow();
        expect(() => coerceUiComponent(42)).not.toThrow();
        expect(() => coerceUiComponent(undefined)).not.toThrow();
        expect(coerceUiComponent(null)).toBe(null);
    });

    it('leaves a non-JSON string alone (does not synthesise an object)', () => {
        const out = coerceUiComponent('not json at all');
        expect(out).toBe('not json at all');
    });

    it('migrates flat-shape: top-level body → props.body (markdown)', () => {
        const out = coerceUiComponent({
            kind: 'markdown',
            body: 'hello world',
        });
        expect(out).toEqual({
            kind: 'markdown',
            props: { body: 'hello world' },
        });
    });

    it('migrates flat-shape: top-level fields → props (status)', () => {
        const out = coerceUiComponent({
            kind: 'status',
            text: 'querying…',
            level: 'progress',
        });
        expect(out).toEqual({
            kind: 'status',
            props: { text: 'querying…', level: 'progress' },
        });
    });

    it('migrates flat-shape for hitl: top-level render → props, and recurses into render', () => {
        const out = coerceUiComponent({
            kind: 'hitl',
            render: [{ kind: 'markdown', body: 'hello' }],
            expect: { kind: 'message' },
            resumePrompt: 'user said {value}',
        });
        expect(out).toEqual({
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'hello' } }],
                expect: { kind: 'message' },
                resumePrompt: 'user said {value}',
            },
        });
    });

    it('defaults a missing hitl.props.resumePrompt to "User said: {value}."', () => {
        const out = coerceUiComponent({
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'hi' } }],
                expect: { kind: 'message' },
            },
        });
        expect((out as { props: { resumePrompt: string } }).props.resumePrompt).toBe('User said: {value}.');
    });

    it('does not override an explicit resumePrompt', () => {
        const out = coerceUiComponent({
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'hi' } }],
                expect: { kind: 'message' },
                resumePrompt: 'Custom template {value}',
            },
        });
        expect((out as { props: { resumePrompt: string } }).props.resumePrompt).toBe('Custom template {value}');
    });
});
