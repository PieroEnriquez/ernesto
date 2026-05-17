import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { defineRoute, RouteRegistry } from '../../route';
import type { Workdir } from '../../workdir';
import { handleExecute } from '../execute';
import type { ExecuteVerbContext } from '../execute';

function makeFakeWorkdir(root = '/tmp/fake-wd'): Workdir {
    return {
        workdirId: 'wd1',
        tier: 'managed',
        workingTreeRoot: root,
        branchRef: 'refs/workdirs/wd1',
        fs: {} as any,
        master: { resolve: async () => ({ kind: 'not-found' }) },
        lock: async (fn: any) => fn(),
    } as Workdir;
}

function makeCtx(scopes: Iterable<string>): ExecuteVerbContext {
    return {
        user: { id: 'u1', email: 'u1@bitrefill.com' },
        scopes: new Set(scopes),
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    };
}

const echoRoute = defineRoute({
    uri: 'test://echo',
    scope: 'test:read',
    input: z.object({ msg: z.string() }),
    output: z.object({ msg: z.string() }),
    handler: async (input, ctx) => {
        // Touch workdirRoot so we can verify it was threaded through.
        ctx.log.info('handler ran', { workdirRoot: ctx.workdirRoot });
        return { msg: input.msg };
    },
});

describe('handleExecute', () => {
    it('happy path: dispatches and returns route output', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const workdir = makeFakeWorkdir();
        const ctx = makeCtx(['test:read']);

        const result = await handleExecute(
            workdir,
            reg,
            { uri: 'test://echo', params: { msg: 'hi' } },
            ctx,
        );

        expect(result).toEqual({ ok: true, data: { msg: 'hi' } });
        expect(ctx.log.info).toHaveBeenCalledWith('execute verb', {
            uri: 'test://echo',
            userId: 'u1',
        });
    });

    it('threads workdir.workingTreeRoot into the route context', async () => {
        const reg = new RouteRegistry();
        const seenRoot = vi.fn();
        reg.register(
            defineRoute({
                uri: 'test://probe',
                scope: 'test:read',
                input: z.object({}),
                output: z.object({ root: z.string().optional() }),
                handler: async (_input, ctx) => {
                    seenRoot(ctx.workdirRoot);
                    return { root: ctx.workdirRoot };
                },
            }),
        );

        await handleExecute(
            makeFakeWorkdir('/tmp/probe-root'),
            reg,
            { uri: 'test://probe', params: {} },
            makeCtx(['test:read']),
        );

        expect(seenRoot).toHaveBeenCalledWith('/tmp/probe-root');
    });

    it('returns invalid_input when uri is empty', async () => {
        const reg = new RouteRegistry();
        const result = await handleExecute(
            makeFakeWorkdir(),
            reg,
            { uri: '', params: {} } as any,
            makeCtx(['test:read']),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_input');
    });

    it('returns invalid_input when uri is missing entirely', async () => {
        const reg = new RouteRegistry();
        const result = await handleExecute(
            makeFakeWorkdir(),
            reg,
            { params: {} } as any,
            makeCtx(['test:read']),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_input');
    });

    it('returns route_not_found for an unknown URI', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);

        const result = await handleExecute(
            makeFakeWorkdir(),
            reg,
            { uri: 'test://nope', params: {} },
            makeCtx(['test:read']),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('route_not_found');
    });

    it('returns scope_denied when the principal is missing the required scope', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);

        const result = await handleExecute(
            makeFakeWorkdir(),
            reg,
            { uri: 'test://echo', params: { msg: 'x' } },
            makeCtx([]),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('scope_denied');
    });

    it('honours the ernesto:agent-ops scope bypass', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);

        const result = await handleExecute(
            makeFakeWorkdir(),
            reg,
            { uri: 'test://echo', params: { msg: 'admin' } },
            makeCtx(['ernesto:agent-ops']),
        );
        expect(result).toEqual({ ok: true, data: { msg: 'admin' } });
    });

    it('defaults params to {} when omitted', async () => {
        const reg = new RouteRegistry();
        reg.register(
            defineRoute({
                uri: 'test://nullary',
                scope: 'test:read',
                input: z.object({}),
                output: z.object({ ok: z.literal(true) }),
                handler: async () => ({ ok: true as const }),
            }),
        );

        const result = await handleExecute(
            makeFakeWorkdir(),
            reg,
            { uri: 'test://nullary' } as any,
            makeCtx(['test:read']),
        );
        expect(result.ok).toBe(true);
    });

    it('logs only the URI and user id (no PII beyond id)', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const ctx = makeCtx(['test:read']);

        await handleExecute(
            makeFakeWorkdir(),
            reg,
            { uri: 'test://echo', params: { msg: 'hi' } },
            ctx,
        );

        const call = (ctx.log.info as any).mock.calls[0];
        expect(call[0]).toBe('execute verb');
        expect(call[1]).toEqual({ uri: 'test://echo', userId: 'u1' });
        expect(JSON.stringify(call[1])).not.toContain('@bitrefill.com');
    });

    it('JSON-decodes stringified params (LLM serialization quirk on nested object params)', async () => {
        // Some models JSON-stringify nested object params instead of
        // sending them as objects in the tool-call envelope. The execute
        // verb normalizes this at the system boundary so every route's
        // Zod schema sees a parsed object.
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const ctx = makeCtx(['test:read']);

        const result = await handleExecute(
            makeFakeWorkdir(),
            reg,
            { uri: 'test://echo', params: '{"msg":"hi from a string"}' },
            ctx,
        );

        expect(result).toEqual({ ok: true, data: { msg: 'hi from a string' } });
    });

    it('leaves non-JSON string params alone (route schema decides)', async () => {
        // If the model passes a non-JSON string AND the route's schema
        // accepts strings, the call still works. If the schema rejects
        // strings, the route returns invalid_input cleanly.
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const ctx = makeCtx(['test:read']);

        const result = await handleExecute(
            makeFakeWorkdir(),
            reg,
            { uri: 'test://echo', params: 'not json — just words' },
            ctx,
        );

        // echoRoute expects {msg: string}; raw string is rejected by route schema.
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_input');
    });
});
