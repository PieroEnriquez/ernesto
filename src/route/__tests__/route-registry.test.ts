import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineRoute } from '../define-route';
import { RouteRegistry } from '../route-registry';

const makeRoute = (uri: string) =>
    defineRoute({
        uri,
        scope: 'x:read',
        input: z.unknown(),
        output: z.unknown(),
        handler: async () => null,
    });

describe('RouteRegistry', () => {
    it('registers and retrieves by URI', () => {
        const r = new RouteRegistry();
        const route = makeRoute('a://one');
        r.register(route);
        expect(r.get('a://one')).toBe(route);
        expect(r.has('a://one')).toBe(true);
    });

    it('returns undefined for missing URIs', () => {
        const r = new RouteRegistry();
        expect(r.get('missing')).toBeUndefined();
        expect(r.has('missing')).toBe(false);
    });

    it('lists every registered route', () => {
        const r = new RouteRegistry();
        r.register(makeRoute('a://one'));
        r.register(makeRoute('a://two'));
        const uris = r.list().map((x) => x.uri).sort();
        expect(uris).toEqual(['a://one', 'a://two']);
    });

    it('throws on duplicate URI', () => {
        const r = new RouteRegistry();
        r.register(makeRoute('a://dup'));
        expect(() => r.register(makeRoute('a://dup'))).toThrow(/duplicate URI/);
    });
});
