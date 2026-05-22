/**
 * `ui-tools/` MCP server — exposes the 13 `ui.*` tools to agents
 * running under any harness that accepts MCP servers (CAS, Cursor,
 * fragua-pi).
 *
 * **Transport.** HTTP-over-loopback via `StreamableHTTPServerTransport`,
 * the same shape the Cursor `mcp-bridge.ts` already ships. Each
 * `createUiMcpServer(...)` call binds a fresh listener to `127.0.0.1`
 * on an ephemeral port; the returned `close()` shuts it down.
 *
 * **Per-run-per-step binding.** The handlers need `runId` / `stepId` /
 * `emit` / `hitl` in context, but the MCP wire protocol carries no
 * such routing — Cursor/CAS just POSTs `{ tool, args }`. The server
 * is therefore parameterized **at construction time** by a
 * `UiToolContext` (or a lazy `ctxResolver`). The harness factory
 * builds one server per (run, step) when wiring an `agent-*` step.
 *
 * The `emit` callback in the context is the same `HandlerContext.emit`
 * the walker passes to step handlers — events flow through the
 * canonical bus + store path, so durability + replay just work.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { UiToolContext } from './types';
import { handleStatus } from './tool-handlers/status';
import { handleTable } from './tool-handlers/table';
import { handleMetric } from './tool-handlers/metric';
import { handleMarkdown } from './tool-handlers/markdown';
import { handleImage } from './tool-handlers/image';
import { handleCode } from './tool-handlers/code';
import { handleLink } from './tool-handlers/link';
import { handleAttachment } from './tool-handlers/attachment';
import { handleProgress } from './tool-handlers/progress';
import { handleInput } from './tool-handlers/input';
import { handleChart } from './tool-handlers/chart';
import { handleTree } from './tool-handlers/tree';
import { handleThinking } from './tool-handlers/thinking';

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

/** Per-tool metadata threaded through the MCP SDK's `registerTool`.
 *  Descriptions are LLM-facing usage guidance per components.md
 *  § The `ui.*` tool surface. */
interface ToolEntry {
    name: string;
    description: string;
    handler: (args: any, ctx: UiToolContext) => Promise<unknown>;
}

const TOOL_ENTRIES: ToolEntry[] = [
    {
        name: 'ui.status',
        description:
            'Show a short progress signal to the user. Use for any in-flight status the user should see — “fetching…”, “summarizing…”, “done”. Update the same status pill in place by passing the same `slotId` across calls instead of emitting a new pill per stage.',
        handler: handleStatus,
    },
    {
        name: 'ui.table',
        description:
            'Render tabular data natively. Use whenever you have rows + columns to show. Don’t dump tables in markdown — the renderer can paginate, sort, and truncate when you emit a `ui.table`.',
        handler: handleTable,
    },
    {
        name: 'ui.metric',
        description:
            'Render a single KPI / metric tile (label + value + optional delta + unit). Use for one-number signals: counts, averages, ratios, totals.',
        handler: handleMetric,
    },
    {
        name: 'ui.markdown',
        description:
            'Render a markdown block. Use for prose, lists, headings — anything that isn’t structured data. Prefer the specialized components (`ui.table`, `ui.metric`, `ui.code`) over inlining their shape as markdown.',
        handler: handleMarkdown,
    },
    {
        name: 'ui.image',
        description:
            'Show an image by URL. The renderer picks the native image affordance; the URL must be reachable from the user’s tier.',
        handler: handleImage,
    },
    {
        name: 'ui.code',
        description:
            'Render a code snippet with syntax highlighting. Specify the `language` so the renderer can highlight; optionally pass `filename` so the renderer can show a file pill.',
        handler: handleCode,
    },
    {
        name: 'ui.link',
        description:
            'Surface a hyperlink to the user. Use a `label` that describes the destination — “Open dashboard”, “View report”.',
        handler: handleLink,
    },
    {
        name: 'ui.attachment',
        description:
            'Reference an attached file (by `ref` key or URI). The subscriber resolves the ref against the workspace’s attachment provider before rendering.',
        handler: handleAttachment,
    },
    {
        name: 'ui.progress',
        description:
            'Show a progress bar (current / total). Update the same bar in place by passing the same `slotId` as `current` advances; subscribers re-render rather than spawning a new bar.',
        handler: handleProgress,
    },
    {
        name: 'ui.input',
        description:
            'Ask the user for a value satisfying the provided JSON Schema. Renderers pick the right widget — buttons for enums, text field for strings, multi-field form for objects. Use this whenever you need a decision or data from the user before continuing. The tool RETURNS the user’s response, typed per `schema`.',
        handler: handleInput,
    },
    {
        name: 'ui.chart',
        description:
            'Render a chart (line, bar, pie, scatter, area). Pass `series` with `data` as `{ x, y }` pairs. The renderer picks the chart engine per tier (image SVC, native widget, ASCII).',
        handler: handleChart,
    },
    {
        name: 'ui.tree',
        description:
            'Render a nested tree of label/value/children nodes. Use for nested structured data (file trees, org charts, JSON outlines).',
        handler: handleTree,
    },
    {
        name: 'ui.thinking',
        description:
            'Stream the agent’s reasoning as a collapsible thinking block. Subscribers may surface this collapsed by default. Update in place by passing the same `slotId` as your reasoning grows.',
        handler: handleThinking,
    },
];

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
 * Build an in-process HTTP MCP server exposing the 13 `ui.*` tools.
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

    // The MCP SDK validates inputs against the Zod schema before
    // delivering to the callback. We use a permissive passthrough
    // shape across all 13 tools — the per-handler argument shape is
    // documented in the tool description for the LLM, and the
    // downstream component renderer / HITL controller do the
    // structural checks. Tightening per-tool Zod shapes is a
    // follow-up (the props interfaces in `components/types.ts` are
    // the source of truth).
    const inputSchema = z.object({}).passthrough();

    for (const entry of TOOL_ENTRIES) {
        const callback = async (
            args: Record<string, unknown>,
        ): Promise<{
            content: Array<{ type: 'text'; text: string }>;
            isError?: boolean;
        }> => {
            try {
                const ctx = resolveCtx();
                const output = await entry.handler(args ?? {}, ctx);
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
                const message =
                    err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: 'text', text: message }],
                    isError: true,
                };
            }
        };

        // The SDK's `registerTool` has overload resolution narrowed by
        // the input schema shape; cast through `unknown` to keep the
        // callback variant clean.
        (mcp.registerTool as unknown as (
            name: string,
            config: Record<string, unknown>,
            cb: typeof callback,
        ) => void)(
            entry.name,
            {
                description: entry.description,
                inputSchema,
            },
            callback,
        );
    }

    // Stateful transport — one session covers the agent's lifetime.
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

/**
 * Workspace-level alternative to {@link createUiMcpServer}: one
 * long-lived MCP server with a per-step context bound via
 * AsyncLocalStorage. The agent step handler enters the ALS scope
 * before sending the prompt to the harness, so any tool calls the
 * agent makes resolve their `UiToolContext` from the ambient scope.
 *
 * This is the Phase-0 cut-over — a per-(run, step) MCP server would
 * be cleaner but requires the harness factory contract to accept
 * per-step `mcpServers` injection. Tracked as a follow-up; the ALS
 * approach is functionally correct and the seam is local.
 */
export interface UiWorkspaceServer {
    /** The McpServerConfig + lifecycle handle. */
    handle: UiMcpServerHandle;
    /** Run `fn()` with `ctx` bound — every `ui.*` tool call inside
     *  this async scope resolves to `ctx`. Nested scopes shadow. */
    withContext<T>(ctx: UiToolContext, fn: () => Promise<T>): Promise<T>;
}

export async function createUiWorkspaceServer(): Promise<UiWorkspaceServer> {
    const als = new AsyncLocalStorage<UiToolContext>();
    const handle = await createUiMcpServer({
        context: () => {
            const ctx = als.getStore();
            if (!ctx) {
                throw new Error(
                    'ui.* tool invoked outside of a per-step context — ' +
                        'wire the agent step handler to enter ' +
                        'UiWorkspaceServer.withContext before sending the prompt.',
                );
            }
            return ctx;
        },
    });
    return {
        handle,
        withContext<T>(ctx: UiToolContext, fn: () => Promise<T>): Promise<T> {
            return als.run(ctx, fn);
        },
    };
}

/** Number of `ui.*` tools the server exposes. Exported for tests +
 *  observability. */
export const UI_TOOL_COUNT = TOOL_ENTRIES.length;

/** List the tool names the server exposes. Exported for tests +
 *  consumers that want to introspect the surface. */
export const UI_TOOL_NAMES: ReadonlyArray<string> = TOOL_ENTRIES.map(
    (e) => e.name,
);
