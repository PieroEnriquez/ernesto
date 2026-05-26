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
