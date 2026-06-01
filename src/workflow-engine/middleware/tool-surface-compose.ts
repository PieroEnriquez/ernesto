/**
 * `toolSurfaceComposeMiddleware` — build per-dispatch MCP server
 * surfaces from `kind.declaration.main.mcpServers`.
 *
 * Replaces the ad-hoc `buildTierAMcpServers` /
 * `createErnestoMcpServer(serviceContext)` patterns that lived
 * scattered across `start-workflow-engine.ts` and product-autofill's
 * `runWorkflowOnce`. The middleware reads the kind's declared MCP
 * server list, calls the backend-supplied composer to build the
 * SDK-shaped map (with session + principal scope), and stashes it
 * on `ctx.annotations.mcpServersFactory` for the agent step handler
 * to consume.
 *
 * Backend wires:
 *
 *   runner.use(toolSurfaceComposeMiddleware({
 *       composer: {
 *           async compose({ kind, principal, sessionId, workdirRoot }) {
 *               // Build proxied external MCPs (mongo, slack, providers).
 *               // Build the ernesto MCP closed over principal + sessionId
 *               // — its `execute` tool calls back into runner.dispatch.
 *               // Build the ui MCP server (workspace-tier only).
 *               return { mcpServers, teardown };
 *           },
 *       },
 *   }));
 *
 * The composer's lifecycle is session-scoped: workspace-tier kinds
 * with `policy.sessionContinuity: 'persistent'` get one MCP build per
 * conversation; server-tier kinds get a fresh build per dispatch
 * with the composer's `teardown` called in the after-hook.
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';
import type { Run } from '../types/runner';

/** Backend-supplied composer. Implementation builds proxied MCP
 *  servers + the per-session ernesto MCP + the ui MCP for
 *  workspace-tier sessions. */
export interface ToolSurfaceComposer {
    compose(ctx: ToolSurfaceComposeInput): Promise<ToolSurfaceComposition>;
}

export interface ToolSurfaceComposeInput {
    kind: string;
    principal: DispatchPreContext['principal'];
    /** Session id (workspace-tier reuses across dispatches; server-tier
     *  is one per dispatch). */
    sessionId: string;
    /** Workdir from the workspace-allocator middleware (if any). */
    workdirRoot?: string;
    /** The kind's declared mcpServers list. */
    mcpServers: ReadonlyArray<string>;
    /** Raw dispatch context — composer can read kind, decl, principal
     *  for tool-surface decisions (e.g. agent's `execute` tool needs
     *  the principal closed over). */
    dispatchCtx: DispatchPreContext;
}

export interface ToolSurfaceComposition {
    /** SDK-shaped mcpServers map: `{ ernesto: {...}, mongo: {...}, ui: {...} }`. */
    mcpServers: Record<string, unknown>;
    disallowedToolsExtra?: ReadonlyArray<string>;
    systemPromptExtras?: ReadonlyArray<string>;
    /** Release function. Called in after-hook for ephemeral sessions;
     *  skipped for persistent (workspace-tier) sessions. */
    teardown?: () => Promise<void> | void;
}

export const TOOL_SURFACE_ANNOTATIONS = {
    DISALLOWED_TOOLS_EXTRA: 'disallowedToolsExtra' as const,
    SYSTEM_PROMPT_EXTRAS: 'systemPromptExtras' as const,
} as const;

export function readDisallowedToolsExtra(
    annotations: Readonly<Record<string, unknown>>,
): string[] {
    const v = annotations[TOOL_SURFACE_ANNOTATIONS.DISALLOWED_TOOLS_EXTRA];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
}

export function readSystemPromptExtras(
    annotations: Readonly<Record<string, unknown>>,
): string[] {
    const v = annotations[TOOL_SURFACE_ANNOTATIONS.SYSTEM_PROMPT_EXTRAS];
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string');
}

export interface ToolSurfaceComposeMiddlewareOpts {
    composer: ToolSurfaceComposer;
    annotationKey?: string;
    /** Override the session-id derivation. Default: use
     *  `ctx.opts.conversationKey` for persistent sessions, else the
     *  dispatch's preallocatedRunId, else a fresh UUID. */
    sessionIdFor?: (ctx: DispatchPreContext) => string;
}

export function toolSurfaceComposeMiddleware(
    opts: ToolSurfaceComposeMiddlewareOpts,
): DispatchMiddleware {
    const annotationKey = opts.annotationKey ?? 'mcpServers';

    return {
        name: 'tool-surface-compose',
        async before(ctx: DispatchPreContext): Promise<DispatchPreContext> {
            // The kind's mcpServers list lives in the declaration's
            // main step (for agent kinds). For route kinds the lib's
            // built-in adapter (route→single-step workflow) doesn't
            // carry an mcpServers list; the middleware skips.
            const main =
                ctx.decl?.kind === 'workflow'
                    ? ctx.decl.declaration.steps.main
                    : undefined;
            const mcpServers = readMcpServersFromMainStep(main);
            if (!mcpServers || mcpServers.length === 0) return ctx;

            const sessionId =
                (opts.sessionIdFor && opts.sessionIdFor(ctx)) ??
                ctx.opts.conversationKey ??
                ctx.opts.preallocatedRunId ??
                `session-${ctx.kind}-${Date.now()}`;

            const composition = await opts.composer.compose({
                kind: ctx.kind,
                principal: ctx.principal,
                sessionId,
                ...(ctx.workdirRoot !== undefined ? { workdirRoot: ctx.workdirRoot } : {}),
                mcpServers,
                dispatchCtx: ctx,
            });

            ctx.annotations[annotationKey] = composition.mcpServers;
            if (composition.teardown) {
                ctx.annotations[`${annotationKey}__teardown`] = composition.teardown;
            }
            if (composition.disallowedToolsExtra && composition.disallowedToolsExtra.length > 0) {
                ctx.annotations[TOOL_SURFACE_ANNOTATIONS.DISALLOWED_TOOLS_EXTRA] =
                    [...composition.disallowedToolsExtra];
            }
            if (composition.systemPromptExtras && composition.systemPromptExtras.length > 0) {
                ctx.annotations[TOOL_SURFACE_ANNOTATIONS.SYSTEM_PROMPT_EXTRAS] =
                    [...composition.systemPromptExtras];
            }
            ctx.sessionId = sessionId;
            return ctx;
        },
        async after(ctx: DispatchPreContext, _run: Run): Promise<void> {
            const teardown = ctx.annotations[`${annotationKey}__teardown`] as
                | (() => Promise<void> | void)
                | undefined;
            if (!teardown) return;
            // Persistent sessions retain the MCP surfaces across runs.
            if (ctx.decl?.policy?.sessionContinuity === 'persistent') return;
            await teardown();
        },
    };
}

/** Best-effort read of `mcpServers` from a step. Lib's WorkflowStep
 *  union has it on `AgentStep`; other step kinds don't define it. */
function readMcpServersFromMainStep(
    step: unknown,
): ReadonlyArray<string> | undefined {
    if (!step || typeof step !== 'object') return undefined;
    const m = (step as { mcpServers?: unknown }).mcpServers;
    if (!Array.isArray(m)) return undefined;
    return m.filter((s): s is string => typeof s === 'string');
}
