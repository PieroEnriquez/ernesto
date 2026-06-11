/**
 * Public surface of the in-house workflow engine.
 *
 * The runner exposes one entry point — `dispatch(kind, inputs,
 * principal, opts)` — that every caller of the AI runtime goes
 * through (HTTP route handlers, background workers, Slack subscribers,
 * the mcp transport (a remote MCP client), the laptop transport,
 * recursive subagent calls). The runner speaks `Principal` (user vs
 * service) + typed `DispatchOpts` natively — no untyped routing
 * record, no `{userId, scopes}` shim.
 *
 *   - Construct via `createRunner({ ... })`.
 *   - Register per-step-kind handlers via `runner.registerStepKind(...)`
 *     (the lib auto-registers `parallel`; the caller wires `agent`,
 *     `route`, `input`, `subworkflow`, `orchestration`).
 *   - Register the workspace workflow reader via
 *     `runner.registerWorkflowReader(...)`.
 *   - Per-transport subscribers (Slack, a remote MCP client, the laptop
 *     transport) attach via `runner.subscribeEvents(...)`. HITL resolvers
 *     call `runner.resumeRun(...)` to settle a paused run.
 *
 * The lib is harness-agnostic — agent step handlers are passed in
 * by the caller, who picks which `Harness` (CAS, Cursor, fragua-pi,
 * mock) backs the step.
 *
 * See workspaces/agent-ops/unified-runtime/.
 */

export { createRunner } from './runner';
export type { CreateRunnerOpts } from './runner';

export type {
    WorkflowRunner,
    DispatchOpts,
    KindRef,
    Run,
    RunHandleStatus,
    RunUsage,
    ResumeRunInput,
    SubscribeEventsOpts,
    EventSubscription,
} from './types/runner';
export { ZERO_USAGE } from './types/runner';

export {
    type Principal,
    type UserPrincipal,
    type ServicePrincipal,
    userPrincipal,
    servicePrincipal,
    isUserPrincipal,
    isServicePrincipal,
    narrowPrincipalScopes,
    principalIdentity,
} from './principal';

export type {
    StepKindHandler,
    HandlerContext,
    HandlerRouting,
    HandlerResult,
    EngineLogger,
    StepKindHandlerCtx,
    StepKindHandlerResult,
    EmitFactEvent,
    EmitFactEventInput,
} from './types/handler';

export type { FactEvent, FactEventType, TypedFactEvent, StoredEvent } from './types/event';

export type { RunState, RunStatus, RunSummary, StorePort, ListRunsOpts, ListEventsOpts, ParkedPause, ResumeState } from './store/port';
export { InMemoryStore } from './store/in-memory-store';

export type { WorkflowReader, WorkflowSummary, WorkflowDetail } from './workflow-reader';

export { HitlController, validateAgainstSchema } from './hitl';
export type { HitlPauseInput, ResumeIntent } from './hitl';

export {
    CONVERSATION_STATE_VERSION,
    loadConversationState,
    updateConversationState,
    appendHitlToTrail,
    decideRendererAction,
    defaultRendererStrategy,
} from './conversation-state';

export { latestHitl, synthesizeHitlFromText, extractTurnState } from './step-emissions';
export type { StepEmissionSummary } from './step-emissions';
export type {
    ConversationState,
    ConversationStatus,
    PendingHitlRecord,
    RendererAction,
    RendererInput,
    RendererPromptStrategy,
    RendererStrategyPrev,
    UiTrailEntry,
} from './conversation-state';

// `HandlerDispatcher` (./dispatch) and `EventBus` (./event-bus) are
// internal engine primitives — not part of the public barrel surface.

// ─── DAG engine expression helper ────────────────────────────────────
// Resolves `${{ inputs.X }}` / `${{ steps.X.outputs.Y }}` tokens.
// Exposed for parsers / validators that surface unresolved-token
// errors at settle time before runtime.
export { resolveExpression } from './engine/run-graph';

// ─── M5 — Unified kind registry ──────────────────────────────────────
// One registry for routes + workflows. `runner.kindRegistry.resolve(uri)`
// is the resolution path; the runner's `dispatch()` consults this
// first, then falls back to the workflow reader.
export { KindRegistry } from './kind-registry';
export type { KindDecl, KindPolicy } from './kind-registry';

// ─── M6 — Middleware chain ───────────────────────────────────────────
// `runner.use(mw)` wires ordered hooks around every dispatch.
// `before` runs in registration order; `after` runs in reverse (LIFO).
export type { DispatchMiddleware, DispatchPreContext } from './middleware';
export { buildPreContext, runBefore, runAfter } from './middleware';

// ─── M6 — Concrete middleware library ────────────────────────────────
// Each middleware is independently shippable, follows the same
// before(ctx)/after(ctx, run) pattern, reads `ctx.decl.policy` to
// decide whether to act.
export { scopeCheckMiddleware, ScopeEscalationError } from './middleware/scope-check';
export { modelRouterMiddleware, ModelRouterError } from './middleware/model-router';
export type { ModelRouterOpts } from './middleware/model-router';
export { timeoutMiddleware } from './middleware/timeout';
export { loggingMiddleware } from './middleware/logging';
export type { LoggingMiddlewareOpts } from './middleware/logging';
export { idempotencyDedupMiddleware, IdempotencyConflictError } from './middleware/idempotency-dedup';
export type { IdempotencyDedupOpts } from './middleware/idempotency-dedup';
export { workspaceAllocatorMiddleware } from './middleware/workspace-allocator';
export type { WorkspaceAllocator, WorkspaceAllocation, WorkspaceAllocatorMiddlewareOpts } from './middleware/workspace-allocator';
export { sandboxBindMiddleware } from './middleware/sandbox-bind';
export type { SandboxBinder, SandboxHooks, SandboxBindMiddlewareOpts } from './middleware/sandbox-bind';
export {
    toolSurfaceComposeMiddleware,
    TOOL_SURFACE_ANNOTATIONS,
    readDisallowedToolsExtra,
    readSystemPromptExtras,
} from './middleware/tool-surface-compose';
export type {
    ToolSurfaceComposer,
    ToolSurfaceComposeInput,
    ToolSurfaceComposition,
    ToolSurfaceComposeMiddlewareOpts,
} from './middleware/tool-surface-compose';
export { eventLogInitMiddleware } from './middleware/event-log-init';
export type { EventLogInitMiddlewareOpts, ClaimRunInput, ClaimRunResult } from './middleware/event-log-init';

// ─── Built-in step-kind handlers ──────────────────────────────────
// Lib-shipped handlers for step kinds whose dispatch logic is
// portable across transports. The host's boot registers them on the
// runner; other transports (the mcp and laptop transports, future
// workers) can register the same handlers without copying glue code.
export { makeRouteStepHandler } from './handlers/route-step';
export type { RouteStepHandlerDeps } from './handlers/route-step';

// ─── Convene — ask-in-a-room pause ────────────────────────────────
// The `convene` step kind posts a typed ask into a room (or a user's
// inbox room — solo HITL is the one-member degenerate case) and parks
// the run on the durable signal rail until the rooms-side resolve (or
// the expire timer) calls `runner.resumeRun`. Room internals stay
// backend-side behind the narrow `ConvenePort`.
export {
    makeConveneStepHandler,
    parseConveneRoomTarget,
    DEFAULT_CONVENE_VALUE_SCHEMA,
    CONVENE_RESUME_ENVELOPE_SCHEMA,
} from './handlers/convene-step';
export type {
    ConvenePort,
    ConveneAskRequest,
    ConveneAskReceipt,
    ConveneProvenance,
    ConveneRoomTarget,
    ConveneStepHandlerDeps,
    ConveneStepResult,
} from './handlers/convene-step';
