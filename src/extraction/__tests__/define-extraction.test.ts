import { describe, it, expect } from 'vitest';
import { defineExtraction } from '../define-extraction';

describe('defineExtraction', () => {
    it('echoes config back as a frozen ExtractionPlugin', () => {
        const plugin = defineExtraction({
            source: 'clickup',
            scope: 'clickup:read',
            description: 'trivial fetcher',
            fetch: async () => ({ entries: [], fetchedAt: '2026-01-01T00:00:00Z' }),
        });

        expect(plugin.source).toBe('clickup');
        expect(plugin.scope).toEqual(['clickup:read']);
        expect(plugin.description).toBe('trivial fetcher');
        expect(Object.isFrozen(plugin)).toBe(true);
        expect(Object.isFrozen(plugin.scope)).toBe(true);
    });

    it('normalizes array scopes', () => {
        const plugin = defineExtraction({
            source: 'drive',
            scope: ['drive:read', 'drive:write'],
            fetch: async () => ({ entries: [], fetchedAt: '2026-01-01T00:00:00Z' }),
        });
        expect(plugin.scope).toEqual(['drive:read', 'drive:write']);
        expect(Object.isFrozen(plugin.scope)).toBe(true);
    });

    it('normalizes single-string scope into a one-element array', () => {
        const plugin = defineExtraction({
            source: 'slack',
            scope: 'slack:read',
            fetch: async () => ({ entries: [], fetchedAt: '2026-01-01T00:00:00Z' }),
        });
        expect(Array.isArray(plugin.scope)).toBe(true);
        expect(plugin.scope).toEqual(['slack:read']);
    });
});
