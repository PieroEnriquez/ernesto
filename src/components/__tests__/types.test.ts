import { describe, it, expect } from 'vitest';
import {
    COMPONENT_KINDS,
    isComponent,
    isInputComponent,
} from '../types';
import type { Component } from '../types';

describe('components/types', () => {
    it('lists all 13 component kinds', () => {
        expect(COMPONENT_KINDS.length).toBe(13);
        // No duplicates.
        expect(new Set(COMPONENT_KINDS).size).toBe(COMPONENT_KINDS.length);
        // Spot-check the headline kinds we lean on elsewhere.
        for (const kind of [
            'status',
            'table',
            'metric',
            'markdown',
            'input',
            'thinking',
        ] as const) {
            expect(COMPONENT_KINDS).toContain(kind);
        }
        // The three old input kinds have been collapsed into one.
        expect(COMPONENT_KINDS).not.toContain('choice_input' as never);
        expect(COMPONENT_KINDS).not.toContain('text_input' as never);
        expect(COMPONENT_KINDS).not.toContain('form' as never);
    });

    it('isComponent accepts a well-shaped status component', () => {
        const c: Component = {
            kind: 'status',
            props: { text: 'fetching…', level: 'progress' },
            slotId: 'main-status',
        };
        expect(isComponent(c)).toBe(true);
    });

    it('isComponent accepts every declared kind structurally', () => {
        const samples: Component[] = [
            { kind: 'status', props: { text: 's' } },
            { kind: 'table', props: { columns: [], rows: [] } },
            { kind: 'metric', props: { label: 'n', value: 1 } },
            { kind: 'markdown', props: { body: 'hi' } },
            { kind: 'image', props: { url: 'https://e/x.png' } },
            { kind: 'code', props: { language: 'ts', body: 'x' } },
            { kind: 'link', props: { url: 'https://e', label: 'L' } },
            { kind: 'attachment', props: { ref: 'a' } },
            { kind: 'progress', props: { label: 'p', current: 1, total: 2 } },
            {
                kind: 'input',
                props: {
                    prompt: 'p',
                    schema: { type: 'string', enum: ['a'] },
                },
            },
            {
                kind: 'chart',
                props: {
                    series: [{ name: 's', data: [{ x: 1, y: 2 }] }],
                    chartType: 'line',
                },
            },
            { kind: 'tree', props: { nodes: [{ label: 'r' }] } },
            { kind: 'thinking', props: { text: 't' } },
        ];
        expect(samples.length).toBe(COMPONENT_KINDS.length);
        for (const c of samples) {
            expect(isComponent(c)).toBe(true);
        }
    });

    it('isComponent rejects malformed payloads', () => {
        expect(isComponent(null)).toBe(false);
        expect(isComponent(undefined)).toBe(false);
        expect(isComponent({})).toBe(false);
        expect(isComponent({ kind: 'status' })).toBe(false);
        expect(isComponent({ kind: 'nope', props: {} })).toBe(false);
        // Old kinds are no longer accepted now that they've collapsed
        // into `input`.
        expect(isComponent({ kind: 'choice_input', props: {} })).toBe(false);
        expect(isComponent({ kind: 'text_input', props: {} })).toBe(false);
        expect(isComponent({ kind: 'form', props: {} })).toBe(false);
        expect(isComponent({ kind: 'status', props: 'oops' })).toBe(false);
        expect(isComponent('status')).toBe(false);
    });

    it('isInputComponent narrows to the pause-the-run kind', () => {
        const input: Component = {
            kind: 'input',
            props: {
                prompt: 'p',
                schema: { type: 'string', enum: ['a'] },
            },
        };
        const status: Component = {
            kind: 'status',
            props: { text: 's' },
        };

        expect(isInputComponent(input)).toBe(true);
        expect(isInputComponent(status)).toBe(false);
    });
});
