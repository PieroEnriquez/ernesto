import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { defineRoute, RouteRegistry, dispatchRoute } from '../../route';
import type { Workdir } from '../../workdir';
import {
    handleExecute,
    EXECUTE_ACCEPTS_BUNDLED_UI,
    executeInputSchema,
} from '../execute';
import type { ExecuteVerbContext } from '../execute';
import type { DispatchResult } from '../../route';
import { extractAndEmitBundledUi } from '../../ui-tools/bundled-ui';
import type { UiComponent } from '../../components/types';

/** Build a `dispatchByUri` backed by a route registry — the minimal
 *  stand-in for the runner-backed dispatcher the backend's tool-surface
 *  composer wires in production. Lets these verb-layer tests exercise
 *  handleExecute against in-memory routes without bringing up the
 *  workflow runner. */
function makeRegistryDispatch(
    reg: RouteRegistry,
    workdir: Workdir,
    scopes: ReadonlySet<string>,
    user: { id: string; email?: string },
    log: ExecuteVerbContext['log'],
    emitComponent?: ExecuteVerbContext['emitComponent'],
): (uri: string, inputs: Record<string, unknown>) => Promise<DispatchResult> {
    return async (uri, inputs) => {
        return dispatchRoute(reg, uri, inputs, {
            user,
            scopes,
            workdirRoot: workdir.workingTreeRoot,
            log,
            ...(emitComponent ? { emitComponent } : {}),
        } as Parameters<typeof dispatchRoute>[3]);
    };
}

// Per-suite tmp workdir — execute now archives full results under
// `<workdir>/workspaces/<ws>/_results/...json`, so the suite needs a
// real-but-isolated root. Created once, blown away after the suite.
let SHARED_TMP_ROOT = '';

beforeAll(async () => {
    SHARED_TMP_ROOT = await fs.mkdtemp(
        path.join(os.tmpdir(), 'ernesto-execute-test-'),
    );
});
afterAll(async () => {
    if (SHARED_TMP_ROOT) {
        await fs.rm(SHARED_TMP_ROOT, { recursive: true, force: true });
    }
});

function makeFakeWorkdir(root?: string): Workdir {
    return {
        workdirId: 'wd1',
        workingTreeRoot: root ?? SHARED_TMP_ROOT,
        branchRef: 'refs/workdirs/wd1',
        fs: {} as any,
        master: { resolve: async () => ({ kind: 'not-found' }) },
        lock: async (fn: any) => fn(),
    } as Workdir;
}

function makeCtx(
    scopes: Iterable<string>,
    opts: {
        reg?: RouteRegistry;
        workdir?: Workdir;
        emitComponent?: ExecuteVerbContext['emitComponent'];
    } = {},
): ExecuteVerbContext {
    const user = { id: 'u1', email: 'u1@example.com' };
    const scopeSet: ReadonlySet<string> = new Set(scopes);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx: ExecuteVerbContext = {
        user,
        scopes: scopeSet,
        log,
    };
    if (opts.reg && opts.workdir) {
        ctx.dispatchByUri = makeRegistryDispatch(
            opts.reg,
            opts.workdir,
            scopeSet,
            user,
            log,
            opts.emitComponent,
        );
    }
    if (opts.emitComponent) ctx.emitComponent = opts.emitComponent;
    return ctx;
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
        const ctx = makeCtx(['test:read'], { reg, workdir });

        const result = await handleExecute(
            workdir,
            reg,
            { uri: 'test://echo', params: { msg: 'hi' }, ui: [] },
            ctx,
        );

        expect(result).toMatchObject({ ok: true, data: { msg: 'hi' } });
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

        const probeRoot = path.join(SHARED_TMP_ROOT, 'probe-root');
        await fs.mkdir(probeRoot, { recursive: true });
        const probeWorkdir = makeFakeWorkdir(probeRoot);
        await handleExecute(
            probeWorkdir,
            reg,
            { uri: 'test://probe', params: {}, ui: [] },
            makeCtx(['test:read'], { reg, workdir: probeWorkdir }),
        );

        expect(seenRoot).toHaveBeenCalledWith(probeRoot);
    });

    it('returns invalid_input when uri is empty', async () => {
        const reg = new RouteRegistry();
        const result = await handleExecute(
            makeFakeWorkdir(),
            reg,
            { uri: '', params: {}, ui: [] } as any,
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
            { params: {}, ui: [] } as any,
            makeCtx(['test:read']),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_input');
    });

    it('returns route_not_found for an unknown URI', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const workdir = makeFakeWorkdir();

        const result = await handleExecute(
            workdir,
            reg,
            { uri: 'test://nope', params: {}, ui: [] },
            makeCtx(['test:read'], { reg, workdir }),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('route_not_found');
    });

    it('returns scope_denied when the principal is missing the required scope', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const workdir = makeFakeWorkdir();

        const result = await handleExecute(
            workdir,
            reg,
            { uri: 'test://echo', params: { msg: 'x' }, ui: [] },
            makeCtx([], { reg, workdir }),
        );
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('scope_denied');
    });

    it('honours the ernesto:agent-ops scope bypass', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const workdir = makeFakeWorkdir();

        const result = await handleExecute(
            workdir,
            reg,
            { uri: 'test://echo', params: { msg: 'admin' }, ui: [] },
            makeCtx(['ernesto:agent-ops'], { reg, workdir }),
        );
        expect(result).toMatchObject({ ok: true, data: { msg: 'admin' } });
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
        const workdir = makeFakeWorkdir();

        const result = await handleExecute(
            workdir,
            reg,
            { uri: 'test://nullary', ui: [] } as any,
            makeCtx(['test:read'], { reg, workdir }),
        );
        expect(result.ok).toBe(true);
    });

    it('logs only the URI and user id (no PII beyond id)', async () => {
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const workdir = makeFakeWorkdir();
        const ctx = makeCtx(['test:read'], { reg, workdir });

        await handleExecute(
            workdir,
            reg,
            { uri: 'test://echo', params: { msg: 'hi' }, ui: [] },
            ctx,
        );

        const call = (ctx.log.info as any).mock.calls[0];
        expect(call[0]).toBe('execute verb');
        expect(call[1]).toEqual({ uri: 'test://echo', userId: 'u1' });
        expect(JSON.stringify(call[1])).not.toContain('@example.com');
    });

    it('JSON-decodes stringified params (LLM serialization quirk on nested object params)', async () => {
        // Some models JSON-stringify nested object params instead of
        // sending them as objects in the tool-call envelope. The execute
        // verb normalizes this at the system boundary so every route's
        // Zod schema sees a parsed object.
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const workdir = makeFakeWorkdir();
        const ctx = makeCtx(['test:read'], { reg, workdir });

        const result = await handleExecute(
            workdir,
            reg,
            { uri: 'test://echo', params: '{"msg":"hi from a string"}', ui: [] },
            ctx,
        );

        expect(result).toMatchObject({ ok: true, data: { msg: 'hi from a string' } });
    });

    it('opts into bundled-ui via EXECUTE_ACCEPTS_BUNDLED_UI', () => {
        expect(EXECUTE_ACCEPTS_BUNDLED_UI).toBe(true);
        const shape = (executeInputSchema as unknown as {
            shape: Record<string, unknown>;
        }).shape;
        expect(shape).toHaveProperty('ui');
    });

    it('wire schema defaults `ui` to [] when omitted, accepts explicit array', () => {
        // We keep the prose-side forcing function (the in-process
        // transport's guidance tells the agent to ALWAYS consider what
        // to bundle on every `execute`).
        // Wire schema is lenient — omitting `ui` defaults to []
        // rather than failing. Trade-off: one fewer retry round-trip
        // when the agent forgets, at the cost of softer schema-level
        // pressure. The bundling habit comes from the prompt + the
        // prior-turn trail, not from rejecting omissions.
        const omitted = executeInputSchema.safeParse({
            uri: 'test://echo',
            params: { msg: 'no bundle' },
        });
        expect(omitted.success).toBe(true);
        if (omitted.success) {
            expect(omitted.data.ui).toEqual([]);
        }

        const explicitEmpty = executeInputSchema.safeParse({
            uri: 'test://echo',
            params: { msg: 'no bundle' },
            ui: [],
        });
        expect(explicitEmpty.success).toBe(true);

        const withBundle = executeInputSchema.safeParse({
            uri: 'test://echo',
            params: { msg: 'with bundle' },
            ui: [{ kind: 'status', props: { text: 'querying' } }],
        });
        expect(withBundle.success).toBe(true);
        if (withBundle.success) {
            expect(withBundle.data.ui).toHaveLength(1);
        }
    });

    it('bundled-ui end-to-end: middleware emits ui components, then handler dispatches the route', async () => {
        // Simulates the MCP dispatch wrapper: the middleware runs FIRST
        // (validating + emitting each ui component), then the handler
        // sees args with `ui` stripped.
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const workdir = makeFakeWorkdir();
        const verbCtx = makeCtx(['test:read'], { reg, workdir });

        const emitted: { type: 'fact.component'; component: UiComponent }[] =
            [];
        const ui: UiComponent[] = [
            { kind: 'thinking', props: { text: 'querying revenue' } },
            { kind: 'status', props: { text: 'Querying…', slotId: 's1' } },
        ];
        const args: Record<string, unknown> = {
            uri: 'test://echo',
            params: { msg: 'bundled' },
            ui,
        };

        const { cleanedArgs, emittedCount } = await extractAndEmitBundledUi(
            args,
            {
                emit: (ev) => emitted.push(ev),
                log: { warn: vi.fn() },
            },
        );
        expect(emittedCount).toBe(2);
        expect(cleanedArgs).not.toHaveProperty('ui');

        // Handler runs on cleanedArgs — the `ui` field never reaches it.
        const result = await handleExecute(
            workdir,
            reg,
            cleanedArgs as Parameters<typeof handleExecute>[2],
            verbCtx,
        );
        expect(result).toMatchObject({
            ok: true,
            data: { msg: 'bundled' },
        });
        // The route's archive layer attaches `file` / `preview`.
        if (result.ok) {
            expect(result.data).toHaveProperty('msg', 'bundled');
        }

        // Both components were emitted in order, on the same emit
        // channel a standalone `ui([…])` call would use.
        expect(emitted).toHaveLength(2);
        expect(emitted.map((e) => e.component.kind)).toEqual([
            'thinking',
            'status',
        ]);
    });

    it('leaves non-JSON string params alone (route schema decides)', async () => {
        // If the model passes a non-JSON string AND the route's schema
        // accepts strings, the call still works. If the schema rejects
        // strings, the route returns invalid_input cleanly.
        const reg = new RouteRegistry();
        reg.register(echoRoute);
        const workdir = makeFakeWorkdir();
        const ctx = makeCtx(['test:read'], { reg, workdir });

        const result = await handleExecute(
            workdir,
            reg,
            { uri: 'test://echo', params: 'not json — just words', ui: [] },
            ctx,
        );

        // echoRoute expects {msg: string}; raw string is rejected by route schema.
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_input');
    });
});
