/**
 * `execute` agent verb.
 *
 * The agent-facing wrapper around `dispatchRoute`. Spec §9 / §30.
 *
 * Schema + description live here (not in the backend) so every tier-frontend
 * uses the same wire shape. The lib stays free of transport (Anthropic SDK,
 * MCP server, Express); transport-binding happens in the per-tier frontends.
 */

import { z } from 'zod';
import type { Workdir } from '../workdir';
import type { RouteRegistry } from '../route';
import { dispatchRoute } from '../route';
import type { DispatchResult } from '../route';
import { bundledUiFieldSchema } from '../ui-tools/bundled-ui';
import type { VerbLogger, VerbUser } from './types';

/**
 * `execute` opts into the bundled-UI side-channel via the optional
 * `ui?: UiComponent[]` field. When the per-tier MCP dispatch wrapper
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

/** Tool-registration opt-in flag. Per-tier frontends that register
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
     *  projected components here so the per-tier subscribers render
     *  automatically without the agent retyping. See
     *  `route/render.ts` + the tool-manifest design doc. */
    emitComponent?: (component: import('../route/render').ManifestComponent) => void;
    /** Workflow run id — captured into the archived tool-result JSON
     *  so multi-call investigations can be correlated to the run that
     *  produced them. Optional; the dispatch layer fabricates a
     *  synthetic id when absent. */
    runId?: string;
    /** Parent-run routing snapshot (slackThreadId, slackChannelId,
     *  tier, parentRunId, …). Routes that fan out to child workflow
     *  runs propagate selected keys here onto the child's
     *  dispatchWorkflow context — the child inherits the parent's UI
     *  surface and tier subscribers route the child's events via
     *  `parentRunId`. See `RouteContext.inheritedRouting`. */
    inheritedRouting?: Readonly<Record<string, unknown>>;
    /**
     * Workflow-by-name dispatcher.
     *
     * **The unification.** Every callable thing is a workflow. Routes
     * happen to be single-step workflows (one `kind: 'route'` step
     * around a URI). Agents are single-step workflows (one
     * `kind: 'agent'` step). Dashboards are multi-step workflows.
     * From the agent's tool surface, all dispatches should look like
     * `execute(name, inputs)` — one verb, one shape.
     *
     * If this hook is wired AND the call's `uri` resolves to a known
     * workflow slug, `handleExecute` dispatches through it (returning
     * the workflow's outputs wrapped in the standard `DispatchResult`
     * envelope). Else it falls through to the route registry — the
     * existing route dispatch path is preserved for back-compat and
     * for routes that aren't yet auto-wrapped as workflows.
     *
     * Returns `null` when the name doesn't resolve to a workflow
     * (caller falls through to route dispatch). Returns a non-null
     * `DispatchResult` either way on dispatch.
     */
    dispatchWorkflowByName?: (
        name: string,
        inputs: Record<string, unknown>,
    ) => Promise<DispatchResult | null>;
}

/**
 * Handle one `execute` call. Re-validates input at the lib boundary
 * (transport may already have done it, but the lib refuses to trust it) and
 * forwards to `dispatchRoute`, threading the workdir's root through.
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
            // Otherwise dispatchRoute will return a clean invalid_input.
        }
    }

    ctx.log.info('execute verb', { uri: parsed.data.uri, userId: ctx.user.id });

    // The unification: try the workflow registry first. If the name
    // resolves to a known workflow slug (single-step or multi-step,
    // doesn't matter), dispatch via fragua with full parent-surface
    // inheritance. Else fall through to route dispatch.
    //
    // From the agent's view, `execute('whales')`, `execute('redshift://run-query')`,
    // and `execute('whale-investigation')` are all the same shape —
    // run the named workflow with these inputs and tell me the result.
    // Single-step routes, single-step agents, multi-step dashboards
    // share one verb and one shape.
    if (ctx.dispatchWorkflowByName) {
        const wfResult = await ctx.dispatchWorkflowByName(
            parsed.data.uri,
            (params as Record<string, unknown>) ?? {},
        );
        if (wfResult !== null) return wfResult;
    }
    return dispatchRoute(registry, parsed.data.uri, params, {
        user: ctx.user,
        scopes: ctx.scopes,
        workdirRoot: workdir.workingTreeRoot,
        log: ctx.log,
        agentSlug: ctx.agentSlug,
        subagentDepth: ctx.subagentDepth,
        onActivity: ctx.onActivity,
        onSubagentStep: ctx.onSubagentStep,
        onSubagentCost: ctx.onSubagentCost,
        ...(ctx.emitComponent ? { emitComponent: ctx.emitComponent } : {}),
        ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
        ...(ctx.inheritedRouting ? { inheritedRouting: ctx.inheritedRouting } : {}),
        ...(parsed.data.previewLimit !== undefined
            ? { previewLimit: parsed.data.previewLimit }
            : {}),
        archiveResults: true,
    });
}
