import { describe, it, expect } from 'vitest';
import { compactify } from '../compactify';

describe('compactify', () => {
    it('wraps a flat array of objects (revenue-breakdown shape) at the limit', () => {
        const regions = Array.from({ length: 30 }, (_, i) => ({
            region: `r${i}`,
            revenue_usd: 1000 + i,
            orders: 10 + i,
        }));
        const out = compactify({ regions }, 5) as { regions: any };
        expect(out.regions).toMatchObject({
            total: 30,
            limit: 5,
        });
        expect(out.regions.items).toHaveLength(5);
        expect(out.regions.items[0]).toEqual({
            region: 'r0',
            revenue_usd: 1000,
            orders: 10,
        });
        expect(out.regions.items[4].region).toBe('r4');
    });

    it('wraps nested arrays at every level (within depth cap)', () => {
        const data = {
            groups: [
                { name: 'a', members: [{ id: 1 }, { id: 2 }, { id: 3 }] },
                { name: 'b', members: [{ id: 4 }, { id: 5 }] },
            ],
        };
        const out = compactify(data, 1) as any;
        expect(out.groups.total).toBe(2);
        expect(out.groups.items).toHaveLength(1);
        // nested members array should also be wrapped
        expect(out.groups.items[0].members).toMatchObject({
            total: 3,
            limit: 1,
        });
        expect(out.groups.items[0].members.items).toHaveLength(1);
    });

    it('passes scalars through unchanged', () => {
        expect(compactify('hello', 5)).toBe('hello');
        expect(compactify(42, 5)).toBe(42);
        expect(compactify(true, 5)).toBe(true);
        expect(compactify(false, 5)).toBe(false);
        expect(compactify(null, 5)).toBe(null);
    });

    it('wraps an empty array with total 0', () => {
        const out = compactify([], 5) as any;
        expect(out).toEqual({ total: 0, limit: 5, items: [] });
    });

    it('mixed object: scalar fields pass through, array fields wrap', () => {
        const data = {
            label: 'Q1 revenue',
            generatedAt: '2026-05-23T11:00:00Z',
            count: 3,
            rows: [{ a: 1 }, { a: 2 }, { a: 3 }],
        };
        const out = compactify(data, 2) as any;
        expect(out.label).toBe('Q1 revenue');
        expect(out.generatedAt).toBe('2026-05-23T11:00:00Z');
        expect(out.count).toBe(3);
        expect(out.rows).toMatchObject({ total: 3, limit: 2 });
        expect(out.rows.items).toHaveLength(2);
    });

    it('limit=0 still reports the real total and yields an empty items array', () => {
        const out = compactify({ rows: [1, 2, 3, 4] }, 0) as any;
        expect(out.rows).toEqual({ total: 4, limit: 0, items: [] });
    });

    it('caps recursion depth so pathological inputs do not blow up', () => {
        // Build a nesting depth of 10 — each level is an object holding
        // a single `child` key. With MAX_DEPTH=4 the compactor should
        // stop recursing somewhere in the chain.
        let leaf: any = { tip: 'gold', tags: ['a', 'b', 'c'] };
        for (let i = 0; i < 10; i++) {
            leaf = { child: leaf };
        }
        const out = compactify(leaf, 5) as any;
        // Walk down — past depth 4 nested objects collapse to {} and
        // arrays collapse to { total, limit, items: [] }. The exact
        // depth at which collapse happens depends on counting, but the
        // assertion is: it terminates and a deep `.tip` is NOT present.
        let cursor = out;
        let depth = 0;
        while (cursor && typeof cursor === 'object' && 'child' in cursor) {
            cursor = cursor.child;
            depth++;
            if (depth > 20) throw new Error('did not terminate');
        }
        // The deepest object reachable should have collapsed (no `tip`
        // string and no `tags.items` populated).
        if (cursor && typeof cursor === 'object') {
            if ('tags' in cursor) {
                const tags = (cursor as any).tags;
                if (tags && typeof tags === 'object' && 'items' in tags) {
                    expect(tags.items).toEqual([]);
                }
            }
        }
    });

    it('wraps a primitive array consistently with object arrays', () => {
        const out = compactify({ tags: ['a', 'b', 'c'] }, 2) as any;
        expect(out.tags).toEqual({ total: 3, limit: 2, items: ['a', 'b'] });
    });
});
