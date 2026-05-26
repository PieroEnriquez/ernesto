/**
 * Tests for the lib's `route` step kind handler — replaces the
 * previously-backend-located route-handler.ts. The handler resolves
 * the route via the runner's KindRegistry, calls
 * `dispatchResolvedRoute`, and projects the result into the walker's
 * step-result shape.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { KindRegistry } from '../kind-registry';
import { makeRouteStepHandler } from '../handlers/route-step';
import { defineRoute } from '../../route/define-route';
import { userPrincipal } from '../principal';
import type { HandlerContext } from '../types/handler';
import type { RouteStep } from '../../workflows/types';

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
    return {
        runId: 'run-1',
        stepId: 'step-1',
        principal: userPrincipal('user-1', ['ws:read']),
        routing: { context: {} },
        runInputs: {},
        annotations: {},
        signal: new AbortController().signal,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        ...overrides,
    };
}

const echoRoute = defineRoute({
    uri: 'redshift://query',
    scope: 'ws:read',
    input: z.object({ sql: z.string() }),
    output: z.object({ rows: z.array(z.any()) }),
    handler: async (input) => ({ rows: [input.sql] }),
});

describe('makeRouteStepHandler', () => {
    it('resolves the route via kindRegistry and returns its output', async () => {
        const kindRegistry = new KindRegistry();
        kindRegistry.registerRoute(echoRoute);
        const handler = makeRouteStepHandler({
            kindRegistry,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        const result = await handler(
            { kind: 'route', uri: 'redshift://query', params: { sql: 'select 1' } } as RouteStep,
            makeCtx(),
        );
        expect(result).toEqual({ kind: 'completed', output: { rows: ['select 1'] } });
    });

    it('returns uri_not_found when the URI is not in the registry', async () => {
        const kindRegistry = new KindRegistry();
        const handler = makeRouteStepHandler({
            kindRegistry,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        const result = await handler(
            { kind: 'route', uri: 'nope://nothing', params: {} } as RouteStep,
            makeCtx(),
        );
        expect(result.kind).toBe('error');
        if (result.kind === 'error') {
            expect(result.code).toBe('uri_not_found');
        }
    });

    it('bridges ctx.emit → emitComponent so route-level manifests fire', async () => {
        const renderingRoute = defineRoute({
            uri: 'reports://daily',
            scope: 'ws:read',
            input: z.object({}),
            output: z.object({ rows: z.array(z.any()) }),
            render: [{ path: 'rows', ui: 'table' as const, columns: [{ id: 'x', label: 'X' }] }],
            handler: async () => ({ rows: [{ x: 1 }, { x: 2 }] }),
        });
        const kindRegistry = new KindRegistry();
        kindRegistry.registerRoute(renderingRoute);
        const handler = makeRouteStepHandler({
            kindRegistry,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        const emit = vi.fn();
        await handler(
            { kind: 'route', uri: 'reports://daily', params: {} } as RouteStep,
            makeCtx({ emit }),
        );
        // The route's render manifest matched its output; emitComponent
        // was wired to ctx.emit → bus and at least one fact.component
        // event landed.
        const componentEmits = emit.mock.calls.filter(
            ([ev]) => ev?.type === 'fact.component',
        );
        expect(componentEmits.length).toBeGreaterThanOrEqual(1);
    });

    it('attaches step-level render manifest to output for the walker projector', async () => {
        const tabularRoute = defineRoute({
            uri: 'data://tabular',
            scope: 'ws:read',
            input: z.object({}),
            output: z.object({ rows: z.array(z.any()), rowCount: z.number() }),
            handler: async () => ({ rows: [{ a: 1 }, { a: 2 }], rowCount: 2 }),
        });
        const kindRegistry = new KindRegistry();
        kindRegistry.registerRoute(tabularRoute);
        const handler = makeRouteStepHandler({
            kindRegistry,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        const result = await handler(
            {
                kind: 'route',
                uri: 'data://tabular',
                params: {},
                render: [
                    {
                        path: 'rows',
                        ui: 'table',
                        columns: [{ id: 'a', label: 'A' }],
                    },
                ],
            } as RouteStep,
            makeCtx(),
        );
        expect(result.kind).toBe('completed');
        if (result.kind === 'completed') {
            const out = result.output as { rows: unknown[]; render: unknown[] };
            expect(out.rows).toEqual([{ a: 1 }, { a: 2 }]);
            expect(Array.isArray(out.render)).toBe(true);
            expect(out.render).toHaveLength(1);
        }
    });

    it('maps dispatch errors to step-error with the resolved code', async () => {
        const scopedRoute = defineRoute({
            uri: 'ws-b://read',
            scope: 'ws:b:read',
            input: z.object({}),
            output: z.object({ ok: z.literal(true) }),
            handler: async () => ({ ok: true as const }),
        });
        const kindRegistry = new KindRegistry();
        kindRegistry.registerRoute(scopedRoute);
        const handler = makeRouteStepHandler({
            kindRegistry,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        const result = await handler(
            { kind: 'route', uri: 'ws-b://read', params: {} } as RouteStep,
            // Caller has 'ws:read' but the route needs 'ws:b:read'.
            makeCtx({ principal: userPrincipal('user-1', ['ws:read']) }),
        );
        expect(result.kind).toBe('error');
        if (result.kind === 'error') {
            expect(result.code).toBe('scope_denied');
        }
    });

    it('requires a user principal — service principals are rejected', async () => {
        const kindRegistry = new KindRegistry();
        kindRegistry.registerRoute(echoRoute);
        const handler = makeRouteStepHandler({
            kindRegistry,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        const result = await handler(
            { kind: 'route', uri: 'redshift://query', params: { sql: 'select 1' } } as RouteStep,
            {
                ...makeCtx(),
                principal: { kind: 'service', workerId: 'w-1', requestId: 'r-1' },
            },
        );
        expect(result.kind).toBe('error');
        if (result.kind === 'error') {
            expect(result.code).toBe('missing_principal');
        }
    });

    it('falls through to ctx.dispatch when the URI resolves to a non-route kind (workflow-from-workflow)', async () => {
        const kindRegistry = new KindRegistry();
        // Stub-register a workflow declaration so resolve() returns
        // something with kind !== 'route'. The step handler should
        // hand off to ctx.dispatch rather than trying to call the
        // route handler.
        kindRegistry.registerWorkflow({
            name: 'child-wf',
            description: 'd',
            version: 1,
            steps: {},
        });
        const dispatchSpy = vi.fn(async () => ({
            runId: 'child-1',
            status: 'completed' as const,
            output: { from_child: true },
        }));
        const handler = makeRouteStepHandler({
            kindRegistry,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        const result = await handler(
            { kind: 'route', uri: 'child-wf', params: { x: 1 } } as RouteStep,
            makeCtx({ dispatch: dispatchSpy }),
        );
        expect(dispatchSpy).toHaveBeenCalledWith('child-wf', { x: 1 });
        expect(result).toEqual({
            kind: 'completed',
            output: { from_child: true },
        });
    });

    it('returns no_recursive_dispatch when the URI resolves to a non-route but ctx.dispatch is absent', async () => {
        const kindRegistry = new KindRegistry();
        kindRegistry.registerWorkflow({
            name: 'child-wf',
            description: 'd',
            version: 1,
            steps: {},
        });
        const handler = makeRouteStepHandler({
            kindRegistry,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        const result = await handler(
            { kind: 'route', uri: 'child-wf', params: {} } as RouteStep,
            makeCtx(), // no dispatch
        );
        expect(result.kind).toBe('error');
        if (result.kind === 'error') {
            expect(result.code).toBe('no_recursive_dispatch');
        }
    });

    it('propagates child workflow errors as the step error', async () => {
        const kindRegistry = new KindRegistry();
        kindRegistry.registerWorkflow({
            name: 'child-wf',
            description: 'd',
            version: 1,
            steps: {},
        });
        const dispatchSpy = vi.fn(async () => ({
            runId: 'child-1',
            status: 'errored' as const,
            error: { code: 'child_blew_up', message: 'specific reason' },
        }));
        const handler = makeRouteStepHandler({
            kindRegistry,
            log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        });
        const result = await handler(
            { kind: 'route', uri: 'child-wf', params: {} } as RouteStep,
            makeCtx({ dispatch: dispatchSpy }),
        );
        expect(result.kind).toBe('error');
        if (result.kind === 'error') {
            expect(result.code).toBe('child_blew_up');
            expect(result.message).toBe('specific reason');
        }
    });
});
