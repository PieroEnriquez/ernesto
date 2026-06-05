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
            uri: '_ernesto://list-dashboards',
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
                '_ernesto://list-dashboards',
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
                '_ernesto://list-dashboards',
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
                '_ernesto://list-dashboards',
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
                '_ernesto://list-dashboards',
                { workspace: 'payments' },
                makeCtx(['ernesto:agent-ops']),
            );
            expect(result).toEqual({ ok: true, data: { ok: true } });
        });
    });

    // ─── Render manifest + staging ─────────────────────────────────────────
    //
    // When a route declares a `render: [...]` manifest AND the caller wires
    // `ctx.emitComponent`, dispatch fires components to the renderer AND
    // shapes the agent-facing result as a stripped envelope carrying
    // `{rendered, staged, note}`. The `staged` sketches are bounded —
    // table rows / chart points must NOT round-trip into the agent's
    // context.

    it('includes a staged sketch alongside rendered kinds when render manifest fires', async () => {
        const reg = new RouteRegistry();
        const rows = Array.from({ length: 250 }, (_, i) => ({
            region: `R${i}`,
            gmv: i * 100,
        }));
        reg.register(
            defineRoute({
                uri: 'test://render-manifest',
                scope: 'test:read',
                input: z.object({}),
                output: z.object({
                    summary: z.string(),
                    rows: z.array(z.object({ region: z.string(), gmv: z.number() })),
                }),
                handler: async () => ({
                    summary: 'GMV €722.8K — concentration risk in US.',
                    rows,
                }),
                render: [
                    { path: 'summary', ui: 'markdown' },
                    {
                        path: 'rows',
                        ui: 'table',
                        caption: 'Revenue by region',
                        columns: [
                            { id: 'region', label: 'Region' },
                            { id: 'gmv', label: 'GMV' },
                        ],
                    },
                ],
            }),
        );

        const emitted: { kind: string }[] = [];
        const result = await dispatchRoute(
            reg,
            'test://render-manifest',
            {},
            {
                ...makeCtx(['test:read']),
                emitComponent: (c) => emitted.push(c as { kind: string }),
            },
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // Components fired to the renderer.
        expect(emitted.map((c) => c.kind)).toEqual(['markdown', 'table']);

        // Stripped envelope: agent sees `{rendered, staged, note}`, NOT the
        // 250-row payload.
        const data = result.data as {
            rendered: string[];
            staged: unknown[];
            note: string;
        };
        expect(data.rendered).toEqual(['markdown', 'table']);
        expect(Array.isArray(data.staged)).toBe(true);
        expect(data.staged).toHaveLength(2);
        expect(data.note).toMatch(/staged/);
        expect(data.note).toMatch(/already rendered for the user/);
        // The note steers the agent toward implications over restatement.
        expect(data.note).toMatch(/cross-tabs|implication|insight/i);

        // Crucial: the table sketch summarizes (cols + rowCount + firstRow),
        // never the full 250 rows.
        const tableSketch = data.staged[1] as {
            kind: string;
            rowCount: number;
            columns: string[];
            firstRow?: Record<string, unknown>;
        };
        expect(tableSketch.kind).toBe('table');
        expect(tableSketch.rowCount).toBe(250);
        expect(tableSketch.columns).toEqual(['Region', 'GMV']);
        expect(tableSketch.firstRow).toEqual({ region: 'R0', gmv: 0 });

        // Hard bound: row data must NOT leak into the `staged` field.
        // The sketch summarizes shape (cols + rowCount + firstRow only);
        // the 250-row array stays in the archive file.
        const stagedJson = JSON.stringify(data.staged);
        expect(stagedJson.length).toBeLessThan(500);
        // None of the row index values (R5..R249) appear in `staged`.
        for (let i = 5; i < 250; i++) {
            expect(stagedJson).not.toContain(`"R${i}"`);
        }
    });

    it('only emits manifest-declared components — attachment policy lives in each surface renderer', async () => {
        const reg = new RouteRegistry();
        reg.register(
            defineRoute({
                uri: 'test://renderer-owns-attach',
                scope: 'test:read',
                input: z.object({}),
                output: z.object({
                    rows: z.array(z.object({ x: z.number() })),
                }),
                handler: async () => ({ rows: [{ x: 1 }, { x: 2 }] }),
                render: [
                    {
                        path: 'rows',
                        ui: 'table',
                        columns: [{ id: 'x', label: 'X' }],
                    },
                ],
            }),
        );

        const emitted: { kind: string }[] = [];
        const result = await dispatchRoute(
            reg,
            'test://renderer-owns-attach',
            {},
            {
                ...makeCtx(['test:read']),
                emitComponent: (c) => emitted.push(c as { kind: string }),
            },
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        // Only the table — no synthetic attachment from dispatch. Each
        // surface's renderer decides whether/how to attach (Slack writes
        // a CSV; CLI may show a path breadcrumb; web shows inline). The
        // archive + `file` projection lives in the `execute` verb, not in
        // this sync dispatch primitive.
        expect(emitted.map((c) => c.kind)).toEqual(['table']);
    });

    it('omits staged when the render manifest is absent', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);

        const result = await dispatchRoute(
            reg,
            'test://echo',
            { msg: 'hi' },
            { ...makeCtx(['test:read']), emitComponent: () => {} },
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // Plain envelope passes through — no stripping when no manifest fires.
        expect(result.data).toEqual({ msg: 'hi' });
        expect((result.data as Record<string, unknown>).staged).toBeUndefined();
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
