/**
 * `execute` agent verb.
 *
 * The agent-facing wrapper around the unified dispatch surface. Spec §9 / §30.
 *
 * Schema + description live here (not in the backend) so every transport frontend
 * uses the same wire shape. The lib stays free of transport (Anthropic SDK,
 * MCP server, Express); transport-binding happens in the per-transport frontends.
 *
 * Dispatch path: every call goes through `ctx.dispatchByUri` (wired by the
 * backend's tool-surface composer to `runner.dispatch`). Routes and workflows
 * resolve through the same kind-registry; the middleware chain fires per
 * dispatch (scope check, timeout, logging, idempotency, retry). The verb
 * layer here adds archive + preview projection on top so the agent gets
 * `{ data, preview, file }` regardless of which URI shape was dispatched.
 */

import { z } from 'zod';
import type { Workdir } from '../workdir';
import type { RouteRegistry } from '../route';
import type { DispatchResult } from '../route';
import { archiveRouteResult } from '../route-results/archive';
import { compactify } from '../route-results/compactify';
import { bundledUiFieldSchema } from '../ui-tools/bundled-ui';
import { randomUUID } from 'crypto';
import type { VerbLogger, VerbUser } from './types';

/**
 * `execute` opts into the bundled-UI side-channel via the optional
 * `ui?: UiComponent[]` field. When the per-transport MCP dispatch wrapper
 * sees `acceptsBundledUi: true` on the registration, the middleware
 * strips `ui` from args (validating + emitting each component) BEFORE
 * `handleExecute` runs. The handler therefore never sees `ui` and its
 * logic stays focused on routing.
 *
 * Declaring `ui` here keeps the wire schema honest — agents see the
 * field in the tool's input schema even though it never reaches the
 * handler.
 */
export const executeInputSchema = z.object({
    uri: z.string().min(1),
    params: z.unknown().default({}),
    /**
     * Inline preview row cap for the agent-facing `preview` field.
     * Default 5. `0` → suppress preview (agent gets only the `file`
     * pointer). String `'all'` → inline the full data (no compactor;
     * eats tokens; caller's choice).
     */
    previewLimit: z.union([z.number().int().min(0), z.literal('all')]).optional(),
    /**
     * Bundled-UI side-channel — REQUIRED list of UiComponents to emit
     * alongside the route call (e.g. a status pill + thinking trace).
     * Pass `[]` explicitly when not bundling. The required-ness is a
     * forcing function: every `execute` call primes the agent to
     * think "what side-channel components do I want?" rather than
     * silently forgetting status pills + thinking notes.
     *
     * Pre-processed by the MCP dispatch middleware; the handler-side
     * `handleExecute` doesn't see this field (the middleware strips
     * it before invoking the handler — see `executeHandlerSchema`).
     */
    ui: bundledUiFieldSchema,
});

/** Tool-registration opt-in flag. Per-transport frontends that register
 *  `execute` as an MCP tool should set `acceptsBundledUi: true` so the
 *  dispatch wrapper pre-processes `args.ui`. */
export const EXECUTE_ACCEPTS_BUNDLED_UI = true;
export type ExecuteInput = z.infer<typeof executeInputSchema>;

/** Handler-internal schema: what `handleExecute` validates against
 *  AFTER the bundled-ui middleware has stripped `ui` from the args.
 *  `ui` is omitted here entirely — the handler never touches it. */
export const executeHandlerSchema = executeInputSchema.omit({ ui: true });
export type ExecuteHandlerInput = z.infer<typeof executeHandlerSchema>;

export const executeOutputSchema = z.discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), data: z.unknown() }),
    z.object({
        ok: z.literal(false),
        error: z.enum([
            'route_not_found',
            'scope_denied',
            'invalid_input',
            'invalid_output',
            'handler_failed',
        ]),
        details: z.unknown().optional(),
    }),
]);

export const EXECUTE_DESCRIPTION = `Run a typed backend route by URI. Routes are content-addressed actions like \`redshift://run-query\`, \`code://list-prs-backend\`, \`app-logs://invoice-investigation\`. Use this when you need to query data, run analytics, or interact with backend systems. List of available routes for this workspace is in \`routes/_index.md\`.

Input: \`{ uri: string, params: object, previewLimit?: number | "all", ui?: UiComponent[] }\`. \`previewLimit\` controls the inline \`preview\` size in the tool_result (default 5; \`0\` → suppress preview entirely, leaving only the \`file\` pointer; \`"all"\` → inline the full data, eats tokens). Optionally pass \`ui:\` to emit components (e.g. a \`status\` pill or \`thinking\` trace) alongside the action — saves an extra \`ui([…])\` SDK round-trip.

Output: \`{ ok: true, data: { ..., preview?, file? } }\` on success — \`preview\` is a compact shape-preserving slice (arrays become \`{ total, limit, items }\`), \`file\` is a workdir-relative path to the full archived JSON (Read it on follow-up turns to avoid re-querying); \`{ ok: false, error, details? }\` on failure (route_not_found / scope_denied / invalid_input / invalid_output / handler_failed).`;

export type ExecuteVerbLogger = VerbLogger;

export interface ExecuteVerbContext {
    user: VerbUser;
    scopes: ReadonlySet<string>;
    log: ExecuteVerbLogger;
    /** §7.12 — see `RouteContext.agentSlug`. Forwarded into dispatchRoute. */
    agentSlug?: string;
    /** §7.12 — see `RouteContext.subagentDepth`. Forwarded into dispatchRoute. */
    subagentDepth?: number;
    /** Activity heartbeat for long-running routes (notably
     *  `_platform://task`). See `RouteContext.onActivity`. */
    onActivity?: () => void;
    /** Per-step sink for subagent SDK assistant messages. See
     *  `RouteContext.onSubagentStep`. Forwarded into dispatchRoute. */
    onSubagentStep?: (text: string) => void;
    /** Per-subagent cost sink. See `RouteContext.onSubagentCost`.
     *  Forwarded into dispatchRoute. */
    onSubagentCost?: (costUsd: number) => void;
    /** `fact.component` emitter — wired from the workflow-engine's
     *  per-step stepEmit when this verb is invoked inside an agent
     *  step. Routes with a `render: [...]` manifest fire their
     *  projected components here so the per-transport subscribers render
     *  automatically without the agent retyping. See
     *  `route/render.ts` + the tool-manifest design doc. */
    emitComponent?: (component: import('../route/render').ManifestComponent) => void;
    /** Workflow run id — captured into the archived tool-result JSON
     *  so multi-call investigations can be correlated to the run that
     *  produced them. Optional; the dispatch layer fabricates a
     *  synthetic id when absent. */
    runId?: string;
    /** Parent-run routing snapshot (slackThreadId, slackChannelId,
     *  transport, parentRunId, …). Routes that fan out to child workflow
     *  runs propagate selected keys here onto the child's
     *  dispatchWorkflow context — the child inherits the parent's UI
     *  surface and transport subscribers route the child's events via
     *  `parentRunId`. See `RouteContext.inheritedRouting`. */
    inheritedRouting?: Readonly<Record<string, unknown>>;
    /**
     * Unified dispatcher for routes + workflows.
     *
     * **The unification.** Every callable URI lives in one kind
     * registry — routes are single-step workflows (one `kind: 'route'`
     * step), agents are single-step workflows (one `kind: 'agent'`
     * step), dashboards are multi-step workflows. From the agent's
     * tool surface, all dispatches look like `execute(uri, inputs)`
     * — one verb, one shape.
     *
     * The callback wraps the runner's `dispatch(...)` primitive and
     * normalizes the resulting `Run<T>` back into the `DispatchResult`
     * envelope the verb returns:
     *   - completed → `{ ok: true, data }`
     *   - errored / canceled → `{ ok: false, error, details }`
     *   - unknown URI → `{ ok: false, error: 'route_not_found' }`
     *
     * For single-step route kinds the implementation unwraps the
     * `{ main: routeData }` outputs envelope; multi-step workflows
     * return their full outputs map as `data`.
     */
    dispatchByUri?: (
        uri: string,
        inputs: Record<string, unknown>,
    ) => Promise<DispatchResult>;
}

/**
 * Handle one `execute` call. Re-validates input at the lib boundary
 * (transport may already have done it, but the lib refuses to trust it),
 * dispatches through `ctx.dispatchByUri` (which the backend wires to
 * `runner.dispatch`), then projects the result into the agent-facing
 * `{ data, preview, file }` envelope.
 *
 * The `registry` parameter is still threaded in so the verb can
 * consult per-route preview compactors via `registry.getCompactor(uri)`
 * — a route-specific preview shape only the route author knows. The
 * registry isn't used for dispatch itself (that's `ctx.dispatchByUri`).
 */
export async function handleExecute(
    workdir: Workdir,
    registry: RouteRegistry,
    input: ExecuteHandlerInput,
    ctx: ExecuteVerbContext,
): Promise<DispatchResult> {
    const parsed = executeHandlerSchema.safeParse(input);
    if (!parsed.success) {
        return {
            ok: false,
            error: 'invalid_input',
            details: { issues: parsed.error.issues },
        };
    }
    // Models occasionally JSON-stringify nested object params when the
    // outer tool call already lives inside a JSON envelope (especially
    // for routes with rich param shapes). Normalize at this boundary so
    // every route's Zod schema sees the parsed object — not a bug to
    // mask, an LLM-serialization quirk to absorb at the system edge.
    let params: unknown = parsed.data.params;
    if (typeof params === 'string') {
        const raw = params;
        try {
            params = JSON.parse(raw);
            ctx.log.info('execute verb: JSON-decoded stringified params', {
                uri: parsed.data.uri,
                originalLength: raw.length,
            });
        } catch {
            // Leave as-is. If the route's input schema actually accepts a
            // string at the top level (rare), the call still succeeds.
            // Otherwise dispatch will return a clean invalid_input.
        }
    }

    ctx.log.info('execute verb', { uri: parsed.data.uri, userId: ctx.user.id });

    if (!ctx.dispatchByUri) {
        return {
            ok: false,
            error: 'handler_failed',
            details: {
                message:
                    'execute verb: ctx.dispatchByUri not wired — backend tool-surface composer must supply it',
            },
        };
    }
    const dispatched = await ctx.dispatchByUri(
        parsed.data.uri,
        (params as Record<string, unknown>) ?? {},
    );
    if (!dispatched.ok) return dispatched;

    // Archive + preview projection. Previously buried inside
    // dispatchRoute's archiveResults branch; lifted here so the
    // dispatch primitive stays focused on routing and the verb owns
    // the agent-facing envelope shape.
    const workdirRoot = workdir.workingTreeRoot;
    const previewLimitRaw = parsed.data.previewLimit ?? 5;
    const inlineAll = previewLimitRaw === 'all';
    const previewLimit = inlineAll ? 0 : Math.max(0, Number(previewLimitRaw) || 0);
    const runId = ctx.runId ?? randomUUID();

    let file: string | undefined;
    try {
        file = await archiveRouteResult({
            workdir: workdirRoot,
            uri: parsed.data.uri,
            params: (params as Record<string, unknown>) ?? {},
            runId,
            data: dispatched.data,
            log: ctx.log,
        });
    } catch (err) {
        ctx.log.warn('archiveRouteResult failed — proceeding without file', {
            uri: parsed.data.uri,
            errorMessage: (err as Error).message,
        });
    }

    let preview: unknown;
    if (inlineAll) {
        preview = dispatched.data;
    } else if (previewLimit > 0) {
        const custom = registry.getCompactor?.(parsed.data.uri);
        preview = custom
            ? custom(dispatched.data, previewLimit)
            : compactify(dispatched.data, previewLimit);
    }

    return {
        ok: true,
        data: dispatched.data,
        ...(preview !== undefined ? { preview } : {}),
        ...(file !== undefined ? { file } : {}),
    };
}
