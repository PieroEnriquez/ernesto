/**
 * `ui-tools/` MCP server — exposes ONE unified `ui` tool to agents.
 *
 * The tool's input is a single {@link UiComponent} OR a
 * `UiComponent[]` (bulk emit). The handler validates each component
 * and emits `fact.component` events into the engine's bus + store.
 *
 * **Transport.** HTTP-over-loopback via `StreamableHTTPServerTransport`.
 * Each `createUiMcpServer(...)` call binds a fresh listener to
 * `127.0.0.1` on an ephemeral port.
 *
 * **Per-run-per-step binding.** The handler needs `runId` / `stepId` /
 * `emit` / `hitl` in context, but the MCP wire protocol carries no
 * such routing. The server is parameterized at construction time by a
 * `UiToolContext` (or a lazy `ctxResolver`). The harness factory builds
 * one server per (run, step) when wiring an `agent-*` step.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { UI_COMPONENT_KINDS } from '../components/types';
import type { UiToolContext } from './types';
import { handleUi } from './tool-handlers/ui';

/** McpServerConfig shape — same as `harness/cursor/mcp-bridge.ts`'s
 *  `SynthMcpServerConfig`. Re-declared structurally so this module
 *  stays decoupled from the Cursor adapter. */
export interface UiMcpServerConfig {
    type: 'http';
    url: string;
}

/** Handle returned by {@link createUiMcpServer}. */
export interface UiMcpServerHandle {
    /** Plug into a harness env's `mcpServers: { ui: handle.config }`. */
    config: UiMcpServerConfig;
    /** Stable record key — `"ui"`. */
    name: 'ui';
    /** Loopback URL (test seam). */
    readonly url: string;
    /** Shut down the listener. Idempotent. */
    close(): Promise<void>;
}

// ─── Input schema ────────────────────────────────────────────────────
//
// The unified `ui` tool accepts a single top-level UiComponent OR an
// array. We keep the wire schema permissive (the handler validates via
// `validateUiComponent`) — the deep validation lives in the lib and
// reports per-component errors so an array call can partially succeed.

const uiComponentSchema = z.object({
    kind: z.enum(UI_COMPONENT_KINDS),
    // `props` is loose at the wire — structural validation is done by
    // `validateUiComponent` after `coerceUiComponent` normalises.
    props: z.union([
        z.record(z.string(), z.unknown()),
        z.string(),
    ]).optional(),
    slotId: z.string().optional(),
}).passthrough();

/**
 * Wire-level acceptance: the agent might JSON-stringify the whole
 * `component` payload (recurring LLM quirk — same one `execute.params`
 * absorbs). Preprocess strings via `JSON.parse` before structural
 * validation; downstream coercion does the rest. Strings that don't
 * parse fall through to Zod's normal error.
 */
const stringOrObjectOrArray = z.preprocess((raw) => {
    if (typeof raw !== 'string') return raw;
    const trimmed = raw.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
    try {
        return JSON.parse(trimmed);
    } catch {
        return raw;
    }
}, z.union([uiComponentSchema, z.array(uiComponentSchema)]));

const uiInputSchema: z.ZodRawShape = {
    component: stringOrObjectOrArray.optional(),
    /** Workdir-relative path to a `.json` file holding the UI
     *  definition. File shape: `{ "component": <UiComponent |
     *  UiComponent[]> }`. Use this when iterating on a large hitl —
     *  fixing one field with `Edit` is cheaper than re-outputting the
     *  whole structure. `component` and `ref` are mutually exclusive
     *  (the handler picks `ref` first when both are present, but the
     *  agent should pick one). */
    ref: z.string().optional(),
};

const UI_TOOL_DESCRIPTION = [
    'Emit one or more UI components to the user. Call this whenever you want the user to SEE something — your answer, side-band status, a progress bar, an attachment, or a `hitl` answer asking the user for a follow-up.',
    '',
    'Two input shapes:',
    '- Inline: `{ component: UiComponent | UiComponent[] }`. Fast path for small payloads.',
    '- Reference: `{ ref: "_ui/turn.json" }` — path is workdir-relative to a `.json` file whose top-level shape is `{ "component": <UiComponent | UiComponent[]> }`. **Prefer this for hitl bodies with more than ~5 renderables**: write the structure once with `Write`, then on validation errors use `Edit` to fix the offending JSON path (the error response carries the file path + the JSON path of every failing field). Cheaper than re-outputting the whole structure each retry.',
    '',
    'Each component is `{ kind, props, slotId? }`. `slotId` updates a prior `status`/`progress`/`thinking` emission in place.',
    '',
    'Kinds (top-level):',
    '- `thinking` — agent-internal reasoning trace (collapsible).',
    '- `status` — short progress pill (`text`, optional `level`).',
    '- `progress` — progress bar (`label`, `current`, `total`).',
    '- `attachment` — file attachment (`filename`, plus `path` workdir-relative OR `url`).',
    '- `hitl` — THE canonical answer for this turn. Carries `render: RenderableComponent[]` (markdown / table / metric / chart / code / image / link / tree / data-ref / file-link), `expect` (the next-turn contract: `message` / `choice` / `form` / `none`), `resumePrompt` (template for the next agent turn), and optional `nextSteps`.',
].join('\n');

/** Resolver shape — yields the per-call context. Most callers pass a
 *  static context (one server per `(runId, stepId)`); the resolver
 *  variant is the seam if a future host wants a multi-step server. */
export type UiToolContextResolver = () => UiToolContext;

export interface CreateUiMcpServerOpts {
    /** Either a static context (per-step server) or a resolver that
     *  yields one at tool-call time. */
    context: UiToolContext | UiToolContextResolver;
}

/**
 * Build an in-process HTTP MCP server exposing the unified `ui` tool.
 * Returns the McpServerConfig + a lifecycle handle.
 */
export async function createUiMcpServer(
    opts: CreateUiMcpServerOpts,
): Promise<UiMcpServerHandle> {
    const resolveCtx: UiToolContextResolver =
        typeof opts.context === 'function'
            ? (opts.context as UiToolContextResolver)
            : () => opts.context as UiToolContext;

    const mcp = new McpServer({
        name: 'ernesto-ui-tools',
        version: '0.0.1',
    });

    const callback = async (
        args: Record<string, unknown>,
    ): Promise<{
        content: Array<{ type: 'text'; text: string }>;
        isError?: boolean;
    }> => {
        try {
            const ctx = resolveCtx();
            // Accept either `{ component: ... }` (the declared wire
            // shape) or a raw component / array (lenient — some MCP
            // clients elide single-arg wrappers).
            const raw =
                args && typeof args === 'object' && 'component' in args
                    ? (args as { component: unknown }).component
                    : args;
            const output = await handleUi(
                raw as Parameters<typeof handleUi>[0],
                ctx,
            );
            return {
                content: [
                    {
                        type: 'text',
                        text:
                            typeof output === 'string'
                                ? output
                                : JSON.stringify(output ?? { ok: true }),
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

    // Cast through `unknown` to keep the registerTool callback variant clean
    // (the SDK has overload resolution narrowed by the input schema shape).
    (mcp.registerTool as unknown as (
        name: string,
        config: Record<string, unknown>,
        cb: typeof callback,
    ) => void)(
        'ui',
        {
            description: UI_TOOL_DESCRIPTION,
            inputSchema: uiInputSchema,
        },
        callback,
    );

    // Stateful transport — one MCP transport connection (its
    // `sessionIdGenerator` is the MCP SDK's API name) covers the
    // agent's lifetime.
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
    });
    await mcp.connect(transport);

    const httpServer: HttpServer = createServer((req, res) => {
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
                            message:
                                err instanceof Error
                                    ? err.message
                                    : String(err),
                        }),
                    );
                }
            });
            req.on('error', (err) => {
                res.statusCode = 500;
                res.end(
                    JSON.stringify({
                        error: 'request_error',
                        message: err.message,
                    }),
                );
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
        // Loopback only.
        httpServer.listen(0, '127.0.0.1');
    });

    const address = httpServer.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}/mcp`;

    let closed = false;
    const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        await new Promise<void>((resolve) => {
            httpServer.close(() => resolve());
        });
        await transport.close();
        await mcp.close();
    };

    return {
        config: { type: 'http', url },
        name: 'ui',
        url,
        close,
    };
}

/** Number of MCP tools the server exposes — now always 1 (`ui`). */
export const UI_TOOL_COUNT = 1;

/** Tool names the server exposes. Stable single-element tuple. */
export const UI_TOOL_NAMES: ReadonlyArray<string> = ['ui'];
