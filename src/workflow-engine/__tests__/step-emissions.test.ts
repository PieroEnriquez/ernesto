import { describe, it, expect } from 'vitest';
import {
    latestHitl,
    synthesizeHitlFromText,
    extractTurnState,
    type StepEmissionSummary,
} from '../step-emissions';
import type { HitlComponent, UiComponent } from '../../components/types';

describe('latestHitl', () => {
    it('returns undefined for an empty stream', () => {
        expect(latestHitl({ components: [] })).toBeUndefined();
    });

    it('returns undefined when no hitl is emitted', () => {
        const components: UiComponent[] = [
            { kind: 'status', props: { text: 'working' } },
            { kind: 'thinking', props: { text: 'hmm' } },
            { kind: 'progress', props: { label: 'p', current: 1, total: 10 } },
        ];
        expect(latestHitl({ components })).toBeUndefined();
    });

    it('finds the most recent hitl in a mixed stream', () => {
        const a: HitlComponent = {
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'first' } }],
                expect: { kind: 'message' },
                resumePrompt: '',
            },
        };
        const b: HitlComponent = {
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'second' } }],
                expect: { kind: 'choice', schema: { enum: ['y', 'n'] } },
                resumePrompt: 'Picked {value}.',
            },
        };
        const components: UiComponent[] = [
            { kind: 'status', props: { text: 'go' } },
            a,
            { kind: 'thinking', props: { text: 'mid' } },
            b,
            { kind: 'progress', props: { label: 'p', current: 9, total: 10 } },
        ];
        expect(latestHitl({ components })).toEqual(b);
    });
});

describe('synthesizeHitlFromText', () => {
    it('returns the expected hitl shape', () => {
        const h = synthesizeHitlFromText('hello world');
        expect(h).toEqual({
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'hello world' } }],
                expect: { kind: 'message' },
                resumePrompt: 'User said: {value}.',
            },
        });
    });
});

describe('extractTurnState', () => {
    it('prefers the explicit hitl over fallback text', () => {
        const explicit: HitlComponent = {
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'pick one' } }],
                expect: { kind: 'choice', schema: { enum: ['a', 'b'] } },
                resumePrompt: 'Chose {value}.',
            },
        };
        const summary: StepEmissionSummary = {
            components: [explicit],
            finalAssistantText: 'ignored because explicit hitl present',
        };
        const result = extractTurnState(summary);
        expect(result.synthesized).toBe(false);
        expect(result.hitl).toEqual(explicit);
    });

    it('synthesizes from assistant text when no hitl emitted', () => {
        const summary: StepEmissionSummary = {
            components: [{ kind: 'status', props: { text: 'go' } }],
            finalAssistantText: 'done — the answer is 42',
        };
        const result = extractTurnState(summary);
        expect(result.synthesized).toBe(true);
        expect(result.hitl.props.render).toEqual([
            { kind: 'markdown', props: { body: 'done — the answer is 42' } },
        ]);
    });

    it('falls back to "(no response)" when there is no text', () => {
        const summary: StepEmissionSummary = { components: [] };
        const result = extractTurnState(summary);
        expect(result.synthesized).toBe(true);
        expect(result.hitl.props.render).toEqual([
            { kind: 'markdown', props: { body: '(no response)' } },
        ]);
    });

    it('treats whitespace-only text as no text (placeholder)', () => {
        const summary: StepEmissionSummary = {
            components: [],
            finalAssistantText: '   \n  ',
        };
        const result = extractTurnState(summary);
        expect(result.synthesized).toBe(true);
        expect(result.hitl.props.render).toEqual([
            { kind: 'markdown', props: { body: '(no response)' } },
        ]);
    });
});
