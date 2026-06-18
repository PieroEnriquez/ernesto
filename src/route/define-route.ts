/**
 * Typed route definition.
 *
 * A `Route` is the lib's unit of executable, scope-gated action with Zod-typed
 * input and output. Routes self-register into a `RouteRegistry`; dispatch then
 * looks up by URI, validates, scope-checks, and runs the handler.
 *
 * Spec: §30 (Route / defineRoute / RouteContext).
 * This module is the minimal scaffolding ahead of backend wiring; it omits
 * the full `RouteContext` shape from §30 (`principal`, the transport
 * (`ctx.transport`), `ernesto`, `workdirId`) because none of those values exist
 * yet on the lib side. The
 * scaffolding context surfaces just what handlers can use today: `user`,
 * a live scope snapshot, an optional `workdirRoot`, and a logger.
 *
 * `user` matches the shape used by `ToolContext` (`skill.ts`) and `SessionUser`
 * (`Session.ts`) — `{ id, email? }`.
 */

import type { z } from 'zod';
import type { RenderEntry } from './render';
import type { Logger, Principal } from '../shared/types';

export type RouteScope = string;

/**
 * A bound, overlay-backed view of one principal's `master-FS ⊕ draft`.
 * Read/glob/grep/exists resolve over the merged overlay; writeDraft/deleteDraft
 * mutate the durable per-user draft. `projectPhysical()` is the LAZY escape
 * hatch that materializes (and memoizes) a real on-disk workdir — only the
 * still-workdir-bound routes (attach/detach/materialize) ever call it; pure
 * readers (e.g. `_ernesto://guidance`) must NEVER project.
 *
 * The concrete implementation lives in the backend (wrapping OverlayReader +
 * PatchStore + a lazy openWorkdir); this interface is the structural contract
 * route handlers consume. All members are async so a physical-backed adapter
 * can satisfy it identically.
 */
export interface WorkspaceView {
    /** Merged-view file read, scope-gated. `null` when out-of-scope, absent, or
     *  deleted (no scope-bit leak) — mirrors OverlayReader.readFile. */
    read(rel: string): Promise<string | null>;
    /** Bash-style glob over readable boundaries, newest-first. */
    glob(pattern: string, opts?: { path?: string }): Promise<string[]>;
    /** Ripgrep over readable boundaries. Shape is intentionally loose (the
     *  backend OverlayGrepResult) so lib need not depend on backend types. */
    grep(opts: { pattern: string; glob?: string; caseInsensitive?: boolean; path?: string }): Promise<unknown>;
    /** True iff the path resolves to readable content in the merged view. */
    exists(rel: string): Promise<boolean>;
    /** Write `content` into the per-user draft at `rel` (ensures base sha first). */
    writeDraft(rel: string, content: string): Promise<void>;
    /** Tombstone `rel` in the per-user draft (ensures base sha first). */
    deleteDraft(rel: string): Promise<void>;
    /** LAZY + memoized: materialize a real on-disk workdir and return its root.
     *  Only workdir-bound routes call this; pure readers must not. */
    projectPhysical(): Promise<{ workdirRoot: string }>;
}

export interface RouteContext {
    user: Principal;
    scopes: ReadonlySet<RouteScope>;
    /** Path to the on-disk working tree when invoked inside a workdir. Absent
     *  for direct HTTP/dispatch paths that do not yet have a workdir bound
     *  (e.g. early mcp-transport `tools/call` before workdir resolution, or unit
     *  tests). Handlers that require it must assert and surface a clear
     *  error — there is no implicit fallback. */
    workdirRoot?: string;
    /** Bound overlay-backed view of `master-FS ⊕ draft` for this dispatch.
     *  REQUIRED (Wave 2): every dispatch carries a bound view. The route-step
     *  engine builder asserts it before constructing this context, and every
     *  transport ctx-site (MCP, laptop, in-process child dispatch, direct HTTP,
     *  Slack) mints one. Routes read/write THROUGH the view; the physical
     *  workdir is a LAZY projection (`projectPhysical()`) used only by the
     *  eager-projection routes. */
    workspaceView: WorkspaceView;
    log: Logger;
    /**
     * Slug of the agent currently running this dispatch — populated by
     * the backend MCP server adapter at agent-dispatch creation time. Absent
     * for HTTP/admin call sites where there is no "agent" running. The
     * §7.12 `_ernesto://task` route reads this to detect self-recursion
     * (rejecting same-slug subagent calls). */
    agentSlug?: string;
    /**
     * §7.12 — how many `task()` invocations deep this dispatch is.
     * 0 (or absent) means the call is from the top-level agent;
     * incremented by the task route before spawning the subagent. Hard
     * cap of 2 enforced in `_ernesto://task` — beyond that, `task()`
     * returns `"subagent failed: max_depth"` without invocation.
     */
    subagentDepth?: number;
    /**
     * Optional heartbeat that long-running routes (notably
     * `_ernesto://task`) call when they observe internal activity. The
     * Slack adapter wires this into its inactivity watchdog so a
     * subagent's SDK events count as "still working" on the parent's
     * stream — without it, a multi-minute subagent looks like silence
     * and gets aborted by the parent's 3-minute watchdog. Routes that
     * are themselves quick can ignore this field.
     */
    onActivity?: () => void;
    /**
     * Optional sink for subagent step text. `_ernesto://task` forwards
     * each formatted child SDK assistant message here so the parent's
     * UI (Slack progress display) can render nested activity as it
     * happens, instead of getting a single final blob. Adapters that
     * don't render progress can ignore it.
     */
    onSubagentStep?: (text: string) => void;
    /**
     * Optional sink for subagent cost. `_ernesto://task` calls this
     * with `metadata.costUsd` after each subagent finishes so the
     * parent's UI (Slack thinking-card) can show the *conversation* cost —
     * parent cost + sum of all subagent costs — instead of just the
     * parent's. Adapters that don't track cost can ignore it.
     */
    onSubagentCost?: (costUsd: number) => void;
    /**
     * Optional `fact.component` emitter for the render-manifest
     * walker. When the dispatched route declares a `render: [...]`
     * manifest AND the caller wires this callback, every entry that
     * resolves against the route's output fires a component event
     * here — typically routed through the workflow-engine's per-step
     * `stepEmit` so the per-transport subscribers (Slack, a remote MCP
     * client, the laptop transport) render automatically without the
     * agent having to retype.
     *
     * Absent / null → manifest is silent (handler's return value still
     * lands; the agent retypes as today). Wiring this hook is what
     * activates the manifest path; the lib doesn't auto-discover.
     */
    emitComponent?: (component: import('./render').ManifestComponent) => void;
    /**
     * Optional run identifier — captured into the archived tool-result
     * file so multi-call investigations can be correlated to the
     * workflow run that produced them. The dispatch layer generates a
     * synthetic id when absent.
     */
    runId?: string;
    /**
     * Parent-run routing inherited from the workflow context the route
     * is dispatched from. Routes that fan out to child runs (notably
     * `_ernesto://task`) propagate selected keys here onto the child's
     * `dispatchWorkflow.context` so the child inherits the parent's UI
     * surface — events from the child carry `parentRunId` + transport
     * routing (slackThreadId/slackChannelId/…), and transport subscribers
     * look up state via parentRunId fallback. Absent on routes called
     * from outside a workflow run (top-level HTTP, tests).
     */
    inheritedRouting?: Readonly<Record<string, unknown>>;
}

/**
 * Dynamic scope — resolves the required scope from a validated input
 * object. The dispatcher parses input first (Zod-typed) and then calls
 * this function to compute which scope(s) the caller must hold.
 *
 * Use for cross-workspace platform routes whose data lives under
 * `workspaces/<w>/...` and whose authorization is per-workspace
 * (e.g. `_ernesto://list-dashboards` requires `${input.workspace}:read`).
 * Static-scope routes — anything where the scope is constant per URI —
 * should keep using the plain `RouteScope | ReadonlyArray<RouteScope>`
 * form for clarity.
 */
export type DynamicScope<I> = (input: I) => RouteScope | ReadonlyArray<RouteScope>;

export interface RouteConfig<I extends z.ZodTypeAny, O extends z.ZodTypeAny> {
    uri: string;
    scope: RouteScope | ReadonlyArray<RouteScope> | DynamicScope<z.infer<I>>;
    input: I;
    output: O;
    description?: string;
    handler: (input: z.infer<I>, ctx: RouteContext) => Promise<z.infer<O>>;
    /**
     * Optional render manifest — projects the typed output to one
     * `Component` per entry. The dispatcher walks this after the
     * handler returns, calling `ctx.emitComponent` for each component
     * the manifest produces. See {@link RenderEntry} + the design
     * doc in `workspaces/agent-ops/workflows-unification/tool-manifest.md`.
     */
    render?: ReadonlyArray<RenderEntry>;
}

export interface Route<I extends z.ZodTypeAny = z.ZodTypeAny, O extends z.ZodTypeAny = z.ZodTypeAny> {
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
    /** Frozen render manifest; absent for routes that opt out and let
     *  the agent author components manually. */
    readonly render?: ReadonlyArray<RenderEntry>;
}

export function defineRoute<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(config: RouteConfig<I, O>): Route<I, O> {
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
        ...(config.render ? { render: Object.freeze([...config.render]) } : {}),
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
export function isDynamicScope<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(route: Route<I, O>): boolean {
    return typeof route.scope === 'function';
}
