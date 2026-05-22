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

/**
 * Dynamic scope — resolves the required scope from a validated input
 * object. The dispatcher parses input first (Zod-typed) and then calls
 * this function to compute which scope(s) the caller must hold.
 *
 * Use for cross-workspace platform routes whose data lives under
 * `workspaces/<w>/...` and whose authorization is per-workspace
 * (e.g. `_platform://list-dashboards` requires `${input.workspace}:read`).
 * Static-scope routes — anything where the scope is constant per URI —
 * should keep using the plain `RouteScope | ReadonlyArray<RouteScope>`
 * form for clarity.
 */
export type DynamicScope<I> = (
    input: I,
) => RouteScope | ReadonlyArray<RouteScope>;

export interface RouteConfig<
    I extends z.ZodTypeAny,
    O extends z.ZodTypeAny,
> {
    uri: string;
    scope: RouteScope | ReadonlyArray<RouteScope> | DynamicScope<z.infer<I>>;
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
    /**
     * Either a frozen array of scope strings (static — same scope for
     * every call) or a function that derives the scope set from
     * validated input. Dispatch reads this after `input.safeParse`
     * succeeds, so a `DynamicScope` always sees typed input.
     */
    readonly scope: ReadonlyArray<RouteScope> | DynamicScope<z.infer<I>>;
    readonly input: I;
    readonly output: O;
    readonly description?: string;
    readonly handler: (input: z.infer<I>, ctx: RouteContext) => Promise<z.infer<O>>;
}

export function defineRoute<
    I extends z.ZodTypeAny,
    O extends z.ZodTypeAny,
>(config: RouteConfig<I, O>): Route<I, O> {
    const scope: ReadonlyArray<RouteScope> | DynamicScope<z.infer<I>> =
        typeof config.scope === 'function'
            ? (config.scope as DynamicScope<z.infer<I>>)
            : Array.isArray(config.scope)
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

/**
 * Resolve a route's declared scope to a concrete `ReadonlyArray<RouteScope>`,
 * calling the dynamic-scope function with typed input if the route declares one.
 *
 * Internal helper — used by `dispatchRoute` after Zod-validating input.
 * Exposed so the derive worker (which renders `@routes-owned`) and
 * registry introspection tools can normalize static and dynamic scopes
 * the same way; for dynamic routes those callers pass `undefined` and
 * get `null`, which they surface as "depends on input".
 */
export function resolveRouteScope<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    route: Route<I, O>,
    input: z.infer<I>,
): ReadonlyArray<RouteScope> {
    if (typeof route.scope === 'function') {
        const raw = (route.scope as DynamicScope<z.infer<I>>)(input);
        return Array.isArray(raw) ? raw : [raw as RouteScope];
    }
    return route.scope;
}

/**
 * `true` when `route.scope` is a function (dynamic — depends on input).
 * Renderers that can't pass input through (e.g. the `@routes-owned`
 * auto-block) use this to decide whether to print the static scope
 * list or a "depends on input" placeholder.
 */
export function isDynamicScope<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
    route: Route<I, O>,
): boolean {
    return typeof route.scope === 'function';
}
