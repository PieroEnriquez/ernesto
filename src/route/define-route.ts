/**
 * Typed route definition.
 *
 * A `Route` is the lib's unit of executable, scope-gated action with Zod-typed
 * input and output. Routes self-register into a `RouteRegistry`; dispatch then
 * looks up by URI, validates, scope-checks, and runs the handler.
 *
 * Spec: `domains/workspaces/README.md` §30 (Route / defineRoute / RouteContext).
 * This module is the minimal scaffolding ahead of B.6 backend wiring; it omits
 * the full `RouteContext` shape from §30 (`principal`, `tier`, `ernesto`,
 * `workdirId`) because none of those values exist yet on the lib side. The
 * scaffolding context surfaces just what handlers can use today: `user`,
 * a live scope snapshot, an optional `workdirRoot`, and a logger.
 *
 * `user` matches the shape used by `ToolContext` (`skill.ts`) and `SessionUser`
 * (`Session.ts`) — `{ id, email? }`.
 */

import type { z } from 'zod';

export type RouteScope = string;

export interface RouteLogger {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
}

export interface RouteUser {
    id: string;
    email?: string;
}

export interface RouteContext {
    user: RouteUser;
    scopes: ReadonlySet<RouteScope>;
    /** Path to the on-disk working tree when invoked inside a workdir. Absent
     *  for direct HTTP/dispatch paths that do not yet have a workdir bound
     *  (e.g. early Tier B `tools/call` before workdir resolution, or unit
     *  tests). Handlers that require it must assert and surface a clear
     *  error — there is no implicit fallback. */
    workdirRoot?: string;
    log: RouteLogger;
    /**
     * Slug of the agent currently running this dispatch — populated by
     * the backend MCP server adapter at session creation time. Absent
     * for HTTP/admin call sites where there is no "agent" running. The
     * §7.12 `_platform://task` route reads this to detect self-recursion
     * (rejecting same-slug subagent calls). */
    agentSlug?: string;
    /**
     * §7.12 — how many `task()` invocations deep this dispatch is.
     * 0 (or absent) means the call is from the top-level agent;
     * incremented by the task route before spawning the subagent. Hard
     * cap of 2 enforced in `_platform://task` — beyond that, `task()`
     * returns `"subagent failed: max_depth"` without invocation.
     */
    subagentDepth?: number;
    /**
     * Optional heartbeat that long-running routes (notably
     * `_platform://task`) call when they observe internal activity. The
     * Slack adapter wires this into its inactivity watchdog so a
     * subagent's SDK events count as "still working" on the parent's
     * stream — without it, a multi-minute subagent looks like silence
     * and gets aborted by the parent's 3-minute watchdog. Routes that
     * are themselves quick can ignore this field.
     */
    onActivity?: () => void;
    /**
     * Optional sink for subagent step text. `_platform://task` forwards
     * each formatted child SDK assistant message here so the parent's
     * UI (Slack progress display) can render nested activity as it
     * happens, instead of getting a single final blob. Adapters that
     * don't render progress can ignore it.
     */
    onSubagentStep?: (text: string) => void;
    /**
     * Optional sink for subagent cost. `_platform://task` calls this
     * with `metadata.costUsd` after each subagent finishes so the
     * parent's UI (Slack thinking-card) can show the *session* cost —
     * parent cost + sum of all subagent costs — instead of just the
     * parent's. Adapters that don't track cost can ignore it.
     */
    onSubagentCost?: (costUsd: number) => void;
}

export interface RouteConfig<
    I extends z.ZodTypeAny,
    O extends z.ZodTypeAny,
> {
    uri: string;
    scope: RouteScope | ReadonlyArray<RouteScope>;
    input: I;
    output: O;
    description?: string;
    handler: (input: z.infer<I>, ctx: RouteContext) => Promise<z.infer<O>>;
}

export interface Route<
    I extends z.ZodTypeAny = z.ZodTypeAny,
    O extends z.ZodTypeAny = z.ZodTypeAny,
> {
    readonly uri: string;
    readonly scope: ReadonlyArray<RouteScope>;
    readonly input: I;
    readonly output: O;
    readonly description?: string;
    readonly handler: (input: z.infer<I>, ctx: RouteContext) => Promise<z.infer<O>>;
}

export function defineRoute<
    I extends z.ZodTypeAny,
    O extends z.ZodTypeAny,
>(config: RouteConfig<I, O>): Route<I, O> {
    const scope = Array.isArray(config.scope)
        ? Object.freeze([...config.scope])
        : Object.freeze([config.scope as RouteScope]);
    return Object.freeze({
        uri: config.uri,
        scope,
        input: config.input,
        output: config.output,
        description: config.description,
        handler: config.handler,
    });
}
