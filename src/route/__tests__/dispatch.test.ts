import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { defineRoute } from '../define-route';
import type { RouteContext } from '../define-route';
import { RouteRegistry } from '../route-registry';
import { dispatchRoute } from '../dispatch';

const makeCtx = (scopes: Iterable<string>): RouteContext => ({
    user: { id: 'u1' },
    scopes: new Set(scopes),
    log: { info: () => {}, warn: () => {}, error: () => {} },
});

const echoRoute = defineRoute({
    uri: 'test://echo',
    scope: 'test:read',
    input: z.object({ msg: z.string() }),
    output: z.object({ msg: z.string() }),
    handler: async (input) => ({ msg: input.msg }),
});

describe('dispatchRoute', () => {
    it('returns ok with the handler payload on happy path', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);

        const result = await dispatchRoute(reg, 'test://echo', { msg: 'hi' }, makeCtx(['test:read']));
        expect(result).toEqual({ ok: true, data: { msg: 'hi' } });
    });

    it('returns route_not_found for unknown URIs', async () => {
        const reg = new RouteRegistry();
        const result = await dispatchRoute(reg, 'test://nope', {}, makeCtx([]));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('route_not_found');
        expect(result.details).toEqual({ uri: 'test://nope' });
    });

    it('returns scope_denied with required + missing when scopes are insufficient', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);

        const result = await dispatchRoute(reg, 'test://echo', { msg: 'hi' }, makeCtx([]));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('scope_denied');
        expect(result.details).toMatchObject({
            required: ['test:read'],
            missing: ['test:read'],
            missingCount: 1,
        });
    });

    it('bypasses scope check when principal holds ernesto:agent-ops', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);

        const result = await dispatchRoute(
            reg,
            'test://echo',
            { msg: 'agent' },
            makeCtx(['ernesto:agent-ops']),
        );
        expect(result).toEqual({ ok: true, data: { msg: 'agent' } });
    });

    it('returns invalid_input with Zod issues when input fails schema', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);

        const result = await dispatchRoute(reg, 'test://echo', { msg: 42 }, makeCtx(['test:read']));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_input');
        const details = result.details as { issues: Array<{ path: Array<string | number> }> };
        expect(details.issues.length).toBeGreaterThan(0);
        expect(details.issues[0].path).toEqual(['msg']);
    });

    it('returns handler_failed with message only (no stack) when handler throws', async () => {
        const reg = new RouteRegistry();
        reg.register(
            defineRoute({
                uri: 'test://boom',
                scope: 'test:read',
                input: z.object({}),
                output: z.object({}),
                handler: async () => {
                    throw new Error('kaboom');
                },
            }),
        );

        const result = await dispatchRoute(reg, 'test://boom', {}, makeCtx(['test:read']));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('handler_failed');
        expect(result.details).toEqual({ message: 'kaboom' });
        expect(JSON.stringify(result.details)).not.toMatch(/at .*\.ts:/);
    });

    // ─── Dynamic scope (function form) ─────────────────────────────────────

    describe('dynamic scope (function form)', () => {
        const platformDashboards = defineRoute({
            uri: '_platform://list-dashboards',
            scope: (input) => `${input.workspace}:read`,
            input: z.object({ workspace: z.string() }),
            output: z.object({ ok: z.literal(true) }),
            handler: async () => ({ ok: true as const }),
        });

        it('resolves scope from validated input and accepts when caller has the derived scope', async () => {
            const reg = new RouteRegistry();
            reg.register(platformDashboards);
            const result = await dispatchRoute(
                reg,
                '_platform://list-dashboards',
                { workspace: 'marketing' },
                makeCtx(['marketing:read']),
            );
            expect(result).toEqual({ ok: true, data: { ok: true } });
        });

        it('denies when caller has a different workspace scope', async () => {
            const reg = new RouteRegistry();
            reg.register(platformDashboards);
            const result = await dispatchRoute(
                reg,
                '_platform://list-dashboards',
                { workspace: 'payments' },
                makeCtx(['marketing:read']),
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBe('scope_denied');
            expect(result.details).toMatchObject({
                required: ['payments:read'],
                missing: ['payments:read'],
            });
        });

        it('reports invalid_input before scope_denied when input is malformed', async () => {
            const reg = new RouteRegistry();
            reg.register(platformDashboards);
            // No `workspace` field → input invalid; we can't derive scope
            // without parsed input, so invalid_input must come back, not
            // scope_denied. This is the post-reorder guarantee.
            const result = await dispatchRoute(
                reg,
                '_platform://list-dashboards',
                { not_a_workspace: 'x' },
                makeCtx([]),
            );
            expect(result.ok).toBe(false);
            if (result.ok) return;
            expect(result.error).toBe('invalid_input');
        });

        it('agent-ops bypass still applies to dynamic-scope routes', async () => {
            const reg = new RouteRegistry();
            reg.register(platformDashboards);
            const result = await dispatchRoute(
                reg,
                '_platform://list-dashboards',
                { workspace: 'payments' },
                makeCtx(['ernesto:agent-ops']),
            );
            expect(result).toEqual({ ok: true, data: { ok: true } });
        });
    });

    it('returns invalid_output and logs loudly when handler returns wrong shape', async () => {
        const reg = new RouteRegistry();
        reg.register(
            defineRoute({
                uri: 'test://liar',
                scope: 'test:read',
                input: z.object({}),
                output: z.object({ count: z.number() }),
                handler: async () => ({ count: 'not-a-number' }) as unknown as { count: number },
            }),
        );

        const errLog = vi.fn();
        const ctx: RouteContext = {
            ...makeCtx(['test:read']),
            log: { info: () => {}, warn: () => {}, error: errLog },
        };

        const result = await dispatchRoute(reg, 'test://liar', {}, ctx);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_output');
        expect(errLog).toHaveBeenCalledOnce();
        expect(errLog.mock.calls[0][0]).toMatch(/output that failed schema/);
    });
});
