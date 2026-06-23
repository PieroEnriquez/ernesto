/**
 * The unified runner surface — `WorkflowRunner` with `dispatch` as the
 * one entry point for every caller of the AI runtime.
 *
 * Clean cut from the prior `dispatchWorkflow({slug, inputs, principal:
 * {userId, scopes}, context, ...})` shape:
 *
 *   - `dispatch(kind, inputs, principal, opts)` is the positional
 *     entry; no `DispatchWorkflowInput` wrapper struct.
 *   - `Principal` is the typed union (user vs service); the legacy
 *     `{userId, scopes}` bag is gone.
 *   - `DispatchOpts` carries the previously-untyped `context` blob as
 *     typed optional fields (`transport`, `parentRunId`, `surfaceRunId`,
 *     `conversationKey`, `preallocatedRunId`).
 *   - The return is `Run<TOut>` — a handle with `events()` async-tail
 *     + `waitForTerminal()` + typed `output` / `error` / `usage`.
 *     `DispatchWorkflowResult` is gone.
 *
 * See workspaces/agent-ops/unified-runtime/architecture.md.
 */

import type { StepKind } from '../../workflows/types';
import type { StepKindHandler } from './handler';
import type { FactEvent } from './event';
import type { WorkflowReader } from '../workflow-reader';
import type { HitlPauseInput } from '../hitl';
import type { Principal } from '../principal';
import type { DispatchMiddleware } from '../middleware';
import type { KindRegistry } from '../kind-registry';

export interface SubscribeEventsOpts {
    lastEventId?: string;
    onEvent: (raw: FactEvent) => void;
    onError?: (err: Error) => void;
}

export interface EventSubscription {
    close(): Promise<void>;
}

/** A reference to a kind (workflow slug, managed-agent URI, route URI,
 *  dashboard URI). All addressable kinds are URIs in the unified
 *  registry; this is a string today, kept as a nominal type for
 *  future tightening (workspace-qualification, semver). */
export type KindRef = string;

/** Top-level dispatch options. Every field is optional with a sane
 *  default; positional arguments cover the load-bearing inputs. */
export interface DispatchOpts {
    /** Transport that originated this dispatch — used by middleware
     *  to pick a renderer + model router defaults. */
    transport?: 'in-process' | 'mcp' | 'laptop' | 'vm';
    /** Parent run's id — set by middleware on recursive dispatch
     *  (subworkflow step, agent's `execute()` tool surface). */
    parentRunId?: string;
    /** UI anchor — defaults to runId at top-level; propagated AS-IS
     *  through descendants so a transport port subscribes by a single id. */
    surfaceRunId?: string;
    /** Long-lived conversation continuity key (persistent in-process
     *  conversations). When set, the runner reuses the conversation
     *  runtime associated with this key (workdir, MCP servers, the
     *  SDK's transcript JSONL). */
    conversationKey?: string;
    /** Caller-allocated runId — lets per-transport subscribers register
     *  state BEFORE dispatch begins emitting. Otherwise the runner
     *  mints one. */
    preallocatedRunId?: string;
    /** Parent abort signal. Cooperative cancellation cascades through
     *  the walker. */
    abortSignal?: AbortSignal;
    /** Free-form context for transport-specific metadata that isn't
     *  promoted to a typed field yet (slackThreadId, mcpConvId,
     *  cliPid, etc.). Middleware reads keys defensively. */
    context?: Readonly<Record<string, unknown>>;
    /** Default render-manifest surfacing for a bare `execute(route)` whose
     *  route does NOT declare its own `surfaceRender`. Unset → the route is
     *  treated as the answer and surfaces (direct dispatch). The agent's
     *  `execute` tool surface sets `false` so an intermediate single-route
     *  lookup doesn't auto-dump its raw render to the thread; a route opts
     *  back in with `surfaceRender: true` (define-route), which always wins. */
    surfaceRender?: boolean;
}

/** Per-run cost rollup. Maintained from `fact.usage` events.
 *  At top-level: aggregates this run + every descendant. */
export interface RunUsage {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheWrite: number;
    costUsd: number;
    durationMs: number;
    /** Per-model line items so the renderer can break out
     *  "Claude Sonnet 4.6: X tokens / $Y" vs "kimi-k2.6: ..." */
    modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUsd?: number }>;
    /** Recursive descendants — populated by the cost-rollup reducer
     *  when this run dispatched children via `kind: 'subworkflow'` or
     *  the harness's subagent surface. */
    childRuns: Array<{ runId: string; usage: RunUsage }>;
}

export const ZERO_USAGE: RunUsage = Object.freeze({
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    durationMs: 0,
    modelUsage: {},
    childRuns: [],
}) as RunUsage;

/** Consumer-facing run status surface. Differs from the store's
 *  internal `RunStatus` (`running | paused | completed | errored |
 *  aborted`) — this surface uses `canceled` (instead of `aborted`)
 *  and `awaiting_input` (instead of `paused`). The mapping happens
 *  in `runner.ts:projectRunHandle`. */
export type RunHandleStatus =
    // Forward (M3) shape only: `dispatch` blocks until terminal today,
    // so `projectRunHandle`/`mapWalkStatus` never emit 'running' yet.
    // Consumers branch on the terminal members below.
    'running' | 'completed' | 'errored' | 'canceled' | 'awaiting_input';

/** Returned by `dispatch(...)` — a handle to an in-flight or
 *  terminal run. Today the runner blocks `dispatch` until terminal,
 *  so this handle is always in a terminal status by the time the
 *  caller sees it. M3 (durable event log + async dispatch) will
 *  flip this to a live handle whose `events()` and
 *  `waitForTerminal()` work mid-flight. The surface is unchanged. */
export interface Run<TOut = Record<string, unknown>> {
    readonly runId: string;
    readonly surfaceRunId: string;
    readonly status: RunHandleStatus;
    readonly output: TOut | undefined;
    readonly error: { code?: string; message?: string; stepId?: string } | undefined;
    readonly usage: RunUsage;
    readonly durationMs: number;
    /** AsyncIterable of fact events for this run. Subscribes to the
     *  bus filtered by `runId`. For terminal runs, callers can still
     *  iterate but will only see events that arrive after subscribe
     *  — past events live in the store (M3 will add replay). */
    events(): AsyncIterable<FactEvent>;
    /** Await terminal state. No-op when already terminal (today: always). */
    waitForTerminal(): Promise<Run<TOut>>;
}

/** Resume intent supplied by a HITL submitter. */
export interface ResumeRunInput {
    runId: string;
    promptId: string;
    value: unknown;
}

/** The runner surface — one `dispatch` function, plus the auxiliary
 *  primitives every transport port needs (subscribe, resume, abort, emit,
 *  pause). */
export interface WorkflowRunner {
    registerStepKind(kind: StepKind, handler: StepKindHandler<any>): void;
    registerWorkflowReader(reader: WorkflowReader): void;
    subscribeEvents(opts: SubscribeEventsOpts): Promise<EventSubscription>;

    /** The unified kind registry — routes + workflows + managed-agents
     *  + dashboards live behind the same resolver. Backend boot wires
     *  per-kind policy via `kindRegistry.registerRoute(...)` /
     *  `kindRegistry.registerWorkflow(...)`. */
    readonly kindRegistry: KindRegistry;

    /** Register a dispatch-middleware in the chain. Order matters:
     *  `before` runs in registration order, `after` runs in reverse. */
    use(middleware: DispatchMiddleware): void;

    /**
     * Dispatch a kind. Returns a `Run<TOut>` handle.
     *
     *   - HTTP route handler → dispatch(uri, params, userPrincipal(...))
     *   - BullMQ worker → dispatch('product-enablement://pipeline', {productId}, servicePrincipal(...))
     *   - Slack subscriber → dispatch('agent-cas', {prompt}, userPrincipal(...), {conversationKey: threadId})
     *   - AI agent's execute() tool → dispatch(uri, params, narrowedPrincipal, {parentRunId, surfaceRunId})
     */
    dispatch<TOut extends Record<string, unknown> = Record<string, unknown>>(
        kind: KindRef,
        inputs: Record<string, unknown>,
        principal: Principal,
        opts?: DispatchOpts,
    ): Promise<Run<TOut>>;

    /** Resume a paused run with a HITL value. */
    resumeRun(input: ResumeRunInput): Promise<void>;
    /** Abort an in-flight run cooperatively. */
    abortRun(runId: string): Promise<void>;
    /** Public bus hook for direct event injection (test harnesses,
     *  HTTP intent endpoints). */
    emitFactEvent(raw: FactEvent): void;
    /** Pause the current step pending a `resumeRun` call. Returned
     *  promise resolves with the validated resume value. Used by the
     *  `ui-tools/` input handler (`ui.input`) which emits a component
     *  AND pauses in one step. */
    pauseForHuman(input: HitlPauseInput): Promise<unknown>;
}
