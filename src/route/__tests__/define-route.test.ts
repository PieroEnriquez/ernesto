import { describe, it, expect, expectTypeOf } from 'vitest';
import { z } from 'zod';
import { defineRoute } from '../define-route';
import type { RouteContext } from '../define-route';

describe('defineRoute', () => {
    it('echoes config back as a frozen Route', () => {
        const route = defineRoute({
            uri: 'test://echo',
            scope: 'test:read',
            input: z.object({ msg: z.string() }),
            output: z.object({ msg: z.string() }),
            description: 'trivial echo',
            handler: async (input) => ({ msg: input.msg }),
        });

        expect(route.uri).toBe('test://echo');
        expect(route.scope).toEqual(['test:read']);
        expect(route.description).toBe('trivial echo');
        expect(Object.isFrozen(route)).toBe(true);
    });

    it('normalizes array scopes', () => {
        const route = defineRoute({
            uri: 'test://multi',
            scope: ['a:read', 'b:read'],
            input: z.unknown(),
            output: z.unknown(),
            handler: async () => null,
        });
        expect(route.scope).toEqual(['a:read', 'b:read']);
    });

    it('infers input/output types from Zod schemas', () => {
        const route = defineRoute({
            uri: 'test://typed',
            scope: 'x:read',
            input: z.object({ n: z.number() }),
            output: z.object({ doubled: z.number() }),
            handler: async (input) => {
                expectTypeOf(input).toEqualTypeOf<{ n: number }>();
                return { doubled: input.n * 2 };
            },
        });

        const ctx: RouteContext = {
            user: { id: 'u1' },
            scopes: new Set(['x:read']),
            log: { info: () => {}, warn: () => {}, error: () => {} },
        };

        expectTypeOf(route.handler).parameter(0).toEqualTypeOf<{ n: number }>();
        expectTypeOf(route.handler).returns.resolves.toEqualTypeOf<{ doubled: number }>();
        expect(ctx.user.id).toBe('u1');
    });
});
