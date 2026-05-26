/**
 * Public surface of the in-house workflow engine.
 *
 * The runner exposes one entry point — `dispatch(kind, inputs,
 * principal, opts)` — that every caller of the AI runtime goes
 * through (HTTP route handlers, BullMQ workers, Slack subscribers,
 * claude.ai MCP, Tier-C CLI, recursive subagent calls). The runner
 * speaks `Principal` (user vs service) + typed `DispatchOpts`
 * natively — no untyped routing record, no `{userId, scopes}` shim.
 *
 *   - Construct via `createRunner({ ... })`.
 *   - Register per-step-kind handlers via `runner.registerStepKind(...)`
 *     (the lib auto-registers `parallel`; the caller wires `agent`,
 *     `route`, `input`, `subworkflow`, `orchestration`).
 *   - Register the workspace workflow reader via
 *     `runner.registerWorkflowReader(...)`.
 *   - Per-tier subscribers (Slack, claude.ai MCP, CLI) attach via
 *     `runner.subscribeEvents(...)`. HITL resolvers call
 *     `runner.resumeRun(...)` to settle a paused run.
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

export type {
    FactEvent,
    FactEventType,
    TypedFactEvent,
    StoredEvent,
    FraguaFactEvent,
} from './types/event';

export type {
    RunState,
    RunStatus,
    RunSummary,
    StorePort,
    ListRunsOpts,
    ListEventsOpts,
} from './store/port';
export { InMemoryStore } from './store/in-memory-store';

export type {
    WorkflowReader,
    WorkflowSummary,
    WorkflowDetail,
} from './workflow-reader';
export { createMultiSourceWorkflowReader } from './workflow-reader';

export {
    HitlController,
    validateAgainstSchema,
    materializeResumePrompt,
} from './hitl';
export type { HitlPauseInput, ResumeIntent } from './hitl';

export {
    CONVERSATION_STATE_VERSION,
    UI_TRAIL_CAP,
    loadConversationState,
    saveConversationState,
    updateConversationState,
    appendUiTrail,
    appendHitlToTrail,
    decideRendererAction,
    composeStrategy,
    defaultRendererStrategy,
} from './conversation-state';

export {
    latestHitl,
    synthesizeHitlFromText,
    extractTurnState,
} from './step-emissions';
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

export { HandlerDispatcher } from './dispatch';
export { EventBus } from './event-bus';
export { pickNextStepId, isTerminalDest } from './engine/edge-selection';

// ─── M3 — Cost rollup reducer ────────────────────────────────────────
// Aggregates fact.usage events into a `RunUsage` projection per run,
// rolled up over a `surfaceRunId` subtree.
export { aggregateUsage, rollupBySurface } from './cost-rollup';

// ─── M4 — TierPort contract ──────────────────────────────────────────
// One shape for Slack / claude.ai MCP / Tier-C CLI / ernesto-MCP.
// Concrete subscribers extend `TierPort`, implementing `render()` +
// `resolveHitl()` in their tier-native UX vocabulary.
export { TierPort } from './tier-port';
export type { HitlPauseRequest, TierEventFilter } from './tier-port';

// ─── M2 — Orchestration step kind expression helpers ─────────────────
// Exposed for parsers / validators that want to surface unresolved
// `${{ }}` token errors at settle time before runtime.
export { resolveExpression } from './engine/orchestration-handler';

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
export {
    scopeCheckMiddleware,
    ScopeEscalationError,
} from './middleware/scope-check';
export {
    modelRouterMiddleware,
    ModelRouterError,
} from './middleware/model-router';
export type { ModelRouterOpts } from './middleware/model-router';
export { timeoutMiddleware } from './middleware/timeout';
export { loggingMiddleware } from './middleware/logging';
export type { LoggingMiddlewareOpts } from './middleware/logging';
export {
    idempotencyDedupMiddleware,
    IdempotencyConflictError,
} from './middleware/idempotency-dedup';
export type { IdempotencyDedupOpts } from './middleware/idempotency-dedup';
