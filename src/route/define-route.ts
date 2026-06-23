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
import type { Transport } from '../managed-agents/types';
import type { WorkspacePatch } from '../workspaces/overlay';
import type { Workdir } from '../workdir/types';

export type RouteScope = string;

/**
 * Result of one `PatchStore.reconcileToMasterHead` — the subset the settle
 * tail reads. `held` (with its reason) means the base did NOT advance (stale
 * clone / overlapping conflicts); the settle tail logs it. The full backend
 * result carries far more diagnostics; the route never needs them.
 */
export interface ReconcileResult {
    held: boolean;
    heldReason?: string;
    headSha: string;
}

/**
 * The narrow, principal-bound slice of the durable per-user draft store that a
 * settle needs — pre-bound to the caller's user id by the backend
 * `settleStaging()` impl, so the route hosts the settle tail WITHOUT reaching
 * for an ambient `PatchStore`. Each method maps 1:1 to the backend PatchStore
 * (minus the userId arg, which the view closed over).
 */
export interface SettleDraftStore {
    /** Clobber-safe per-file merge of the draft onto `headSha`; the settle's
     *  pre-3-way reconcile AND the post-settle base re-pin (the add/add
     *  deadlock fix) both call it. */
    reconcileToMasterHead(headSha: string): Promise<ReconcileResult>;
    /** Project the (now-reconciled) durable draft for this user. */
    forUser(): Promise<WorkspacePatch>;
    /** Forget exactly the settled subset (content-keyed compare-and-forget). */
    forgetSettled(committedPaths: readonly string[], settledPatch: WorkspacePatch): Promise<void>;
    /** Draft paths under the given workspace prefixes — feeds the guiding
     *  selection-error lists (`selection_required` / `invalid_path`). */
    listDraftPaths(workspaces: readonly string[]): Promise<string[]>;
}

/**
 * Everything the shared settle-core needs to commit one principal's draft,
 * handed back by `WorkspaceView.settleStaging()` so the route never constructs
 * an ambient `PatchStore` or opens a workdir itself. The draft has already been
 * reconciled onto `masterHeadSha` and re-projected into `patch` (cheap); the
 * disposable staging tree is opened + prepared PRISTINE LAZILY via
 * `openWorkdir()` — the core forces it only when it is actually about to commit,
 * so a pre-commit selection refusal (`selection_required` / `invalid_path` /
 * `empty_patch`) never materializes a workdir (parity with the pre-collapse
 * tails, which short-circuited those before opening their staging tree).
 */
export interface SettleStaging {
    /** Open (refresh to current main + reset PRISTINE for `read-tree -m -u`) the
     *  disposable on-disk git staging tree `settleFromOverlay` shells git
     *  through, returning the `Workdir` (carrying the per-user `lock` so
     *  concurrent same-user settles serialize, and `workingTreeRoot` for the
     *  post-settle master-FS propagate). LAZY: the core calls this only on the
     *  commit path, AFTER every cheap selection/empty refusal has passed — so a
     *  refused settle opens nothing. Memoized by the impl. */
    openWorkdir(): Promise<Workdir>;
    /** The caller's durable draft, AFTER the pre-settle reconcile onto
     *  `masterHeadSha`. */
    patch: WorkspacePatch;
    /** `patch.baseSha` lifted out for the settle input (the merge base). */
    baseSha: string;
    /** Master-FS HEAD the draft was reconciled onto — the settle's `ours`. */
    masterHeadSha: string;
    /** Principal-bound draft store for the forget / re-pin / list ops the
     *  tail runs after the commit. */
    draft: SettleDraftStore;
}

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
    /**
     * Open a DISPOSABLE git staging tree + the caller's reconciled draft +
     * base — everything `_ernesto://settle` needs to commit, without the route
     * reaching for an ambient `PatchStore` or opening a workdir itself. The
     * impl (backend `makeOverlayWorkspaceView`) opens a per-user staging
     * workdir, resets it pristine, reconciles the durable draft onto current
     * master HEAD, and re-projects it.
     *
     * Pure-reader views (guidance, search, tests) leave this unimplemented:
     * the default throws, so a non-settle dispatch never pays the cost and a
     * mis-wired settle fails loudly rather than corrupting the repo. */
    settleStaging(): Promise<SettleStaging>;
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
     * Transport that originated this dispatch chain (`in-process` | `mcp` |
     * `laptop` | `vm`). Populated by the route-step handler from the run's
     * `routing.transport`. The settle route reads it to stamp the commit's
     * `Transport`/`Isolation` trailers — the one place a route's behavior is
     * (cosmetically) transport-aware. Absent for legacy/test dispatches that
     * don't set a transport (settle then defaults the trailer to `in-process`).
     *
     * Promotes the prior backend `ctx as { transport? }` cast at the settle
     * route into a typed field (Raptor-3 W0). */
    transport?: Transport;
    /**
     * Id of the bound workdir for this dispatch, when one was resolved
     * (in-process session workdir). Populated by the route-step handler from
     * `routing.context.workdirId`. The settle route stamps it as the commit's
     * `Workdir-Id` trailer. Absent on transports that hold no durable workdir
     * (mcp/laptop/vm use a per-user disposable staging tree). Promotes the
     * prior backend cast (Raptor-3 W0). */
    workdirId?: string;
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
    /**
     * Whether this route's `render:` manifest SURFACES to the user when the
     * route is the dispatched unit. Takes precedence over the caller's default
     * (`DispatchOpts.surfaceRender`):
     *   - `true`    → surface even when an agent calls it as a tool — the route
     *                 IS a user-facing answer (a report / dashboard).
     *   - `false`   → never auto-surface (pure data/lookup; the agent
     *                 synthesizes from it).
     *   - omitted   → fall back to the caller default: a DIRECT dispatch
     *                 surfaces (the route is the answer); an agent `execute`
     *                 does NOT (intermediate data) — so an unflagged lookup the
     *                 agent calls can't leak its raw render to the thread.
     */
    surfaceRender?: boolean;
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
    /** See {@link RouteConfig.surfaceRender}. Drives whether a bare
     *  `execute(route)`'s render manifest surfaces, via `runner.resolveKind`. */
    readonly surfaceRender?: boolean;
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
        ...(config.surfaceRender !== undefined ? { surfaceRender: config.surfaceRender } : {}),
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
