import { describe, it, expect } from 'vitest';
import { defineExtraction } from '../define-extraction';
import { ExtractionRegistry } from '../extraction-registry';

const makePlugin = (source: string) =>
    defineExtraction({
        source,
        scope: 'x:read',
        fetch: async () => ({ entries: [], fetchedAt: '2026-01-01T00:00:00Z' }),
    });

describe('ExtractionRegistry', () => {
    it('registers and retrieves by source', () => {
        const r = new ExtractionRegistry();
        const plugin = makePlugin('clickup');
        r.register(plugin);
        expect(r.get('clickup')).toBe(plugin);
        expect(r.has('clickup')).toBe(true);
    });

    it('returns undefined for missing sources', () => {
        const r = new ExtractionRegistry();
        expect(r.get('missing')).toBeUndefined();
        expect(r.has('missing')).toBe(false);
    });

    it('lists every registered plugin', () => {
        const r = new ExtractionRegistry();
        r.register(makePlugin('clickup'));
        r.register(makePlugin('drive'));
        const sources = r
            .list()
            .map((x) => x.source)
            .sort();
        expect(sources).toEqual(['clickup', 'drive']);
    });

    it('throws on duplicate source', () => {
        const r = new ExtractionRegistry();
        r.register(makePlugin('clickup'));
        expect(() => r.register(makePlugin('clickup'))).toThrow(/duplicate source/);
    });
});
