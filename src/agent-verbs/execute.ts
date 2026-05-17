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
import type { VerbLogger, VerbUser } from './types';

export const executeInputSchema = z.object({
    uri: z.string().min(1),
    params: z.unknown().default({}),
});
export type ExecuteInput = z.infer<typeof executeInputSchema>;

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

Input: \`{ uri: string, params: object }\` where \`uri\` is the route URI and \`params\` matches the route's documented input schema.

Output: \`{ ok: true, data: <route output> }\` on success; \`{ ok: false, error, details? }\` on failure (route_not_found / scope_denied / invalid_input / invalid_output / handler_failed).`;

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
}

/**
 * Handle one `execute` call. Re-validates input at the lib boundary
 * (transport may already have done it, but the lib refuses to trust it) and
 * forwards to `dispatchRoute`, threading the workdir's root through.
 */
export async function handleExecute(
    workdir: Workdir,
    registry: RouteRegistry,
    input: ExecuteInput,
    ctx: ExecuteVerbContext,
): Promise<DispatchResult> {
    const parsed = executeInputSchema.safeParse(input);
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
    });
}
