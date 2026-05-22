/**
 * Public surface of the in-house workflow engine.
 *
 * The runner here satisfies the structural `FraguaInstance` shape the
 * backend's `wire-fragua.ts` calls into; the integration story is:
 *
 *   - The backend constructs a runner via `createRunner({ ... })`.
 *   - The runner is handed to `wireErnestoIntoFragua(runner, opts)`,
 *     which calls `registerStepKind` for each of the six kinds, then
 *     `registerWorkflowReader` with the workspaces scanner.
 *   - Per-tier subscribers (Slack, claude.ai MCP, CLI) attach via
 *     `subscribeEvents`. HITL submitters call `resumeRun` to settle
 *     a paused run.
 *
 * The lib is harness-agnostic — agent-* step handlers are passed in
 * by the caller, who picks which `Harness` (CAS, Cursor, fragua-pi,
 * mock) backs each kind.
 */

export { createRunner } from './runner';
export type { CreateRunnerOpts } from './runner';

export type {
    WorkflowRunner,
    DispatchWorkflowInput,
    DispatchWorkflowResult,
    ResumeRunInput,
    SubscribeEventsOpts,
    EventSubscription,
} from './types/runner';

export type {
    StepKindHandler,
    HandlerContext,
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

export { HitlController, validateAgainstSchema } from './hitl';
export type { HitlPauseInput, ResumeIntent } from './hitl';

export { HandlerDispatcher } from './dispatch';
export { EventBus } from './event-bus';
export { pickNextStepId, isTerminalDest } from './engine/edge-selection';
