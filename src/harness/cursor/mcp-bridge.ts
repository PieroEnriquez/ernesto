/**
 * MCP-server synthesis layer — the step-2 architectural unlock.
 *
 * Cursor's `Agent.create({ mcpServers })` (see
 * `node_modules/@cursor/sdk/dist/esm/options.d.ts`) accepts only two
 * `McpServerConfig` shapes:
 *
 *   - stdio:   `{ command, args?, env?, cwd? }`
 *   - http/sse: `{ url, headers?, auth? }`
 *
 * The canonical `Harness` interface accepts `ToolSpec.kind === 'fn'`
 * (in-process closures). The bridge gives the Cursor adapter (and any
 * other harness whose backend can't accept inline fn tools — fragua in
 * step 3) a way to expose those fns to Cursor as MCP tools without
 * leaking the closure across a process boundary.
 *
 * ## Why HTTP-over-loopback, not stdio
 *
 * Three options were considered:
 *
 *   1. **stdio + subprocess.** Cleanest interop with Cursor (`command +
 *      args`), but the fn handler is an in-memory closure — there's no
 *      way to serialize it to the child process. We'd need an IPC
 *      bridge or a registry RPC anyway, at which point we have an
 *      HTTP server inside-out.
 *
 *   2. **In-memory transport (`InMemoryTransport.createLinkedPair`).**
 *      Lowest overhead — would be the right answer if Cursor's MCP
 *      client accepted a JS callback as a transport. It doesn't; the
 *      Cursor binary speaks the wire protocol over an actual transport.
 *
 *   3. **HTTP/SSE on loopback.** One ephemeral local listener per
 *      synthesized server; the fn handler stays in-process; Cursor
 *      gets `{ url: 'http://127.0.0.1:<port>/mcp' }`. Hermetic for
 *      tests (no port reservations across machines), no subprocess to
 *      manage, no IPC.
 *
 * **(3) wins** because it preserves the in-process closure invariant
 * while satisfying Cursor's wire-protocol expectation. The deciding
 * factor: closures aren't serializable, and any subprocess approach
 * therefore has to round-trip through an in-process RPC server anyway
 * — so spawning an extra child buys nothing.
 *
 * ## Idempotency
 *
 * `wrapFnAsMcpServer` is memoized on `toolSpec` identity: two calls
 * with the same `ToolSpec` object return the same `{ url, server }`
 * pair and never spawn a second listener. Callers that pass freshly
 * constructed ToolSpecs each time will get new servers; the harness
 * compile-time path is expected to dedup at the call site (one create
 * per agent, server cache on the handle).
 *
 * ## Lifecycle
 *
 * Each synthesized server returns a `close()` handle. The Cursor
 * adapter calls `close()` on every server when the agent is disposed
 * (`SDKAgent.close()` / `Symbol.asyncDispose`).
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { ToolSpec } from '../types';

/** A `ToolSpec` narrowed to the fn variant — the only kind the bridge
 *  handles. `mcp`/`builtin` tools flow through unchanged from
 *  `compile.ts`. */
export type FnToolSpec = Extract<ToolSpec, { kind: 'fn' }>;

/** Cursor `McpServerConfig`'s http/sse shape (subset). Re-declared
 *  structurally so this module doesn't depend on `@cursor/sdk` at
 *  import time — keeps the synthesis primitive testable without the
 *  Cursor peer dep. */
export interface SynthMcpServerConfig {
    type: 'http';
    url: string;
}

/** Returned by {@link wrapFnAsMcpServer}. Holds the Cursor-facing
 *  `config` plus a `close()` that the adapter calls on agent disposal. */
export interface SynthMcpServerHandle {
    /** The `McpServerConfig` value to put into Cursor's
     *  `mcpServers: { <name>: config }` record. */
    config: SynthMcpServerConfig;
    /** Stable name slugified from the tool id; useful as the
     *  `mcpServers` record key. */
    name: string;
    /** Shut down the listener. Idempotent. */
    close(): Promise<void>;
    /** Test seam — the actual loopback URL (with port) used by Cursor. */
    readonly url: string;
}

const handleCache = new WeakMap<FnToolSpec, SynthMcpServerHandle>();

/**
 * Synthesize an in-process HTTP MCP server exposing `toolSpec` as a
 * single MCP tool. Returns the Cursor-facing `McpServerConfig` plus a
 * lifecycle handle.
 *
 * The listener binds to `127.0.0.1` on an ephemeral port (port `0`).
 * Caller-controlled `host` / `port` overrides aren't supported by
 * design — the bridge is meant to be invisible to the consumer.
 */
export async function wrapFnAsMcpServer(toolSpec: FnToolSpec): Promise<SynthMcpServerHandle> {
    // Idempotency: same spec → same handle, no double-spawn.
    const cached = handleCache.get(toolSpec);
    if (cached) return cached;

    const mcp = new McpServer({
        name: `synth-${toolSpec.name}`,
        version: '0.0.0',
    });

    // Register the single tool. We give it a permissive Zod
    // `passthrough` schema so the SDK delivers the raw args object
    // (rather than the `extra` request handler context) as the first
    // argument to our callback. The fn handler is the source of
    // truth for validation against `toolSpec.schema` — the lib
    // threads that JSON schema through under `_meta.inputSchemaRaw`
    // so MCP clients (Cursor included) can introspect it.
    // Use a permissive Zod passthrough so the SDK delivers raw args
    // to the callback (rather than the request-handler extra). The
    // fn handler is the source of truth for validation against
    // `toolSpec.schema`; the lib threads that JSON schema through
    // under `_meta.inputSchemaRaw` so MCP clients (Cursor included)
    // can introspect it.
    const inputSchema = z.object({}).passthrough();
    const handlerCallback = async (
        args: Record<string, unknown>,
    ): Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
    }> => {
        try {
            const output = await toolSpec.handler(args ?? {});
            return {
                content: [
                    {
                        type: 'text',
                        text: typeof output === 'string' ? output : JSON.stringify(output),
                    },
                ],
            };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return {
                content: [{ type: 'text', text: message }],
                isError: true,
            };
        }
    };
    // `registerTool`'s overload resolution narrows `cb` based on the
    // shape of `inputSchema`. Cast through `unknown` keeps the
    // boundary explicit — runtime contract is "callback receives the
    // parsed args object".
    (mcp.registerTool as unknown as (name: string, config: Record<string, unknown>, cb: typeof handlerCallback) => void)(
        toolSpec.name,
        {
            description: toolSpec.description,
            inputSchema,
            _meta: { inputSchemaRaw: toolSpec.schema },
        },
        handlerCallback,
    );

    // Stateful transport: the MCP SDK's stateless mode requires a
    // fresh transport per request (otherwise message ids collide
    // across clients). Stateful mode lets one transport drive the
    // whole agent lifetime; the MCP transport's `sessionId` (the MCP
    // SDK's API name) is generated server-side on initialize.
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
    });
    await mcp.connect(transport);

    const httpServer: HttpServer = createServer((req, res) => {
        // Body bufferer — Streamable HTTP transports accept either a
        // pre-parsed body or one they can read off the request. We
        // pass the parsed body through `handleRequest` for POSTs and
        // let the transport drive GET (SSE) directly.
        if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            req.on('data', (chunk: Buffer) => chunks.push(chunk));
            req.on('end', () => {
                try {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    const body = raw.length > 0 ? JSON.parse(raw) : undefined;
                    void transport.handleRequest(req, res, body);
                } catch (err) {
                    res.statusCode = 400;
                    res.end(
                        JSON.stringify({
                            error: 'parse_error',
                            message: err instanceof Error ? err.message : String(err),
                        }),
                    );
                }
            });
            req.on('error', (err) => {
                res.statusCode = 500;
                res.end(JSON.stringify({ error: 'request_error', message: err.message }));
            });
        } else {
            void transport.handleRequest(req, res);
        }
    });

    await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
            httpServer.off('listening', onListening);
            reject(err);
        };
        const onListening = (): void => {
            httpServer.off('error', onError);
            resolve();
        };
        httpServer.once('error', onError);
        httpServer.once('listening', onListening);
        // Loopback only — never expose the synth server beyond the host.
        httpServer.listen(0, '127.0.0.1');
    });

    const address = httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/mcp`;
    const name = `synth_${slugify(toolSpec.name)}`;

    let closed = false;
    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
        await transport.close();
        await mcp.close();
        handleCache.delete(toolSpec);
    };

    const handle: SynthMcpServerHandle = {
        config: { type: 'http', url },
        name,
        url,
        close,
    };
    handleCache.set(toolSpec, handle);
    return handle;
}

/**
 * Wrap each fn tool in a `ToolSpec[]`, returning the synthesized
 * `mcpServers` record (Cursor's input shape) plus a `closeAll()`
 * lifecycle hook. Non-fn tools are returned in `passThrough` so the
 * compile step can route them via Cursor's native MCP / builtin
 * registration paths.
 */
export async function wrapFnToolsAsMcpServers(tools: ToolSpec[] | undefined): Promise<{
    mcpServers: Record<string, SynthMcpServerConfig>;
    handles: SynthMcpServerHandle[];
    passThrough: ToolSpec[];
    closeAll: () => Promise<void>;
}> {
    const mcpServers: Record<string, SynthMcpServerConfig> = {};
    const handles: SynthMcpServerHandle[] = [];
    const passThrough: ToolSpec[] = [];

    for (const tool of tools ?? []) {
        if (tool.kind === 'fn') {
            const handle = await wrapFnAsMcpServer(tool);
            mcpServers[handle.name] = handle.config;
            handles.push(handle);
        } else {
            passThrough.push(tool);
        }
    }

    const closeAll = async (): Promise<void> => {
        await Promise.all(handles.map((h) => h.close()));
    };

    return { mcpServers, handles, passThrough, closeAll };
}

/** Lowercase + non-alphanum collapsed to `_`. Used as the
 *  `mcpServers` record key. */
function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}
