import { describe, it, expect } from 'vitest';
import {
    COMPONENT_KINDS,
    isComponent,
    isInputComponent,
} from '../types';
import type { Component } from '../types';

describe('components/types', () => {
    it('lists all 15 component kinds', () => {
        expect(COMPONENT_KINDS.length).toBe(15);
        // No duplicates.
        expect(new Set(COMPONENT_KINDS).size).toBe(COMPONENT_KINDS.length);
        // Spot-check the headline kinds we lean on elsewhere.
        for (const kind of [
            'status',
            'table',
            'metric',
            'markdown',
            'choice_input',
            'text_input',
            'form',
            'thinking',
        ] as const) {
            expect(COMPONENT_KINDS).toContain(kind);
        }
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
                kind: 'choice_input',
                props: { prompt: 'p', choices: [{ value: 'a', label: 'A' }] },
            },
            { kind: 'text_input', props: { prompt: 'p' } },
            {
                kind: 'form',
                props: {
                    prompt: 'p',
                    fields: [{ id: 'f', label: 'F', type: 'string' }],
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
        expect(isComponent({ kind: 'status', props: 'oops' })).toBe(false);
        expect(isComponent('status')).toBe(false);
    });

    it('isInputComponent narrows to the three pause-the-run kinds', () => {
        const choice: Component = {
            kind: 'choice_input',
            props: {
                prompt: 'p',
                choices: [{ value: 'a', label: 'A' }],
            },
        };
        const text: Component = {
            kind: 'text_input',
            props: { prompt: 'p' },
        };
        const form: Component = {
            kind: 'form',
            props: { prompt: 'p', fields: [] },
        };
        const status: Component = {
            kind: 'status',
            props: { text: 's' },
        };

        expect(isInputComponent(choice)).toBe(true);
        expect(isInputComponent(text)).toBe(true);
        expect(isInputComponent(form)).toBe(true);
        expect(isInputComponent(status)).toBe(false);
    });
});
