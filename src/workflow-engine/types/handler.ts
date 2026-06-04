/**
 * Per-step-kind handler interface.
 *
 * Each step kind's handler receives a typed `HandlerContext` carrying
 * the principal (user vs service), the typed routing surface
 * (transport/surfaceRunId/parentRunId/conversationKey + free-form context),
 * a per-step `emit` for fact events, an abort signal, and a logger.
 * Handlers return one of three terminal shapes (`completed`,
 * `paused_human`, `error`).
 */

import type { WorkflowStep } from '../../workflows/types';
import type { UiComponent } from '../../components/types';
import type { TypedFactEvent } from './event';
import type { Principal } from '../principal';

/** Logger surface — matches the backend's `RouteLogger`. */
export interface EngineLogger {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
}

/**
 * Per-step emit shape — handlers call this to publish in-step fact
 * events (assistant deltas, tool calls/results, usage, …) without
 * having to thread the bus + store + seq generator themselves. The
 * walker pre-binds it to the current `(runId, stepId)` and the
 * canonical `emit()` path so the routing/seq invariants stay
 * centralised.
 *
 * The handler supplies the typed payload; the walker fills in
 * `runId`, `stepId`, and `ts` on the way out, so callers can pass
 * a partial — see `EmitFactEventInput`.
 */
export type EmitFactEvent = (event: EmitFactEventInput) => void;

/** Discriminated union of step-scoped fact-event payloads a handler
 *  may emit. Mirrors `TypedFactEvent` minus the redundant `runId`,
 *  `stepId`, and `ts` fields the walker injects. */
export type EmitFactEventInput =
    | { type: 'fact.assistant_delta'; text: string; ts?: number }
    | {
          type: 'fact.tool_call';
          toolUseId: string;
          name: string;
          input: unknown;
          ts?: number;
      }
    | {
          type: 'fact.tool_result';
          toolUseId: string;
          output: unknown;
          isError: boolean;
          ts?: number;
      }
    | { type: 'fact.thinking'; text: string; ts?: number }
    | {
          type: 'fact.usage';
          inputTokens: number;
          outputTokens: number;
          cacheRead?: number;
          cacheWrite?: number;
          costUsd?: number;
          modelUsage?: Record<
              string,
              { inputTokens: number; outputTokens: number; costUsd?: number }
          >;
          ts?: number;
      }
    | {
          type: 'fact.subagent_started';
          slug: string;
          subRunId: string;
          ts?: number;
      }
    | {
          type: 'fact.subagent_completed';
          slug: string;
          subRunId: string;
          result: unknown;
          ts?: number;
      }
    | {
          type: 'fact.assistant_message';
          content: unknown;
          ts?: number;
      }
    | {
          /** Structured UI intent. Emitted by the `ui-tools/` MCP tool
           *  handlers when an agent invokes `ui.<kind>(...)`. The
           *  walker stamps `stepId` + `ts` and persists the event;
           *  per-transport subscribers translate to native UI. */
          type: 'fact.component';
          component: UiComponent;
          ts?: number;
      };

export interface HandlerContext {
    runId: string;
    stepId: string;
    /**
     * Typed principal of the dispatch — either a user principal
     * (with `userId` + scope set) or a service principal (with
     * `workerId` + `requestId`). Step handlers read this for scope
     * narrowing, billing attribution, render gating, and HITL
     * availability decisions.
     */
    principal: Principal;
    /**
     * Per-run typed dispatch context. Carries the structured
     * fields previously buried in an untyped `routing` record:
     * `transport`, `parentRunId`, `surfaceRunId`, `conversationKey`,
     * plus the originating caller's free-form `context` blob for
     * transport-specific metadata. Step handlers thread these
     * into recursive dispatches so descendants inherit the surface.
     */
    routing: HandlerRouting;
    /**
     * Top-level workflow inputs — the `inputs` argument to
     * `runner.dispatch(...)`. Step handlers that interpolate
     * `${{ inputs.X }}` references (orchestration, expression,
     * future kinds) read from here. The walker threads this
     * unchanged into every step's context.
     */
    runInputs: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
    log: EngineLogger;
    /** Working tree pinned for this run (route + agent handlers thread
     *  it into ernesto's route ctx). */
    workdirRoot?: string;
    /**
     * Per-dispatch annotations set by middleware. The agent step
     * handler reads `annotations.mcpServers` (set by
     * `toolSurfaceComposeMiddleware`), `annotations.sandboxHooks`
     * (set by `sandboxBindMiddleware`), `annotations.providerEnv`
     * (set by `modelRouterMiddleware`), etc. — keys are the
     * `annotationKey` of the middleware that wrote them.
     *
     * Frozen-ish at handler entry; middleware ran before the walk.
     */
    annotations: Readonly<Record<string, unknown>>;
    /** Publish a step-scoped fact event onto the run's event stream.
     *  Pre-bound to the current step by the walker — handlers that
     *  ignore this just lose mid-step granularity (lifecycle events
     *  still flow through the walker). */
    emit?: EmitFactEvent;
    /** Recursive dispatch back into the runner. Pre-bound by the
     *  walker to inherit this run's principal + routing (transport,
     *  parentRunId set to `ctx.runId`, surfaceRunId, conversationKey).
     *  Step handlers call this when a step needs to invoke another
     *  callable by URI — workflow-from-workflow, route-from-step,
     *  or any future registry kind. The route step kind handler is
     *  the canonical caller: when `step.uri` resolves to a non-route
     *  kind, the handler falls through to `ctx.dispatch(step.uri,
     *  step.params)` and the runner takes it from there.
     *
     *  Optional because legacy step handlers and unit-test contexts
     *  don't need to recurse; only the route step handler currently
     *  threads it. */
    dispatch?: (
        uri: string,
        inputs: Record<string, unknown>,
    ) => Promise<RecursiveDispatchResult>;
}

/** Minimal recursive-dispatch return shape exposed to step handlers.
 *  Mirrors the runner's `Run<T>` projection at the fields a step
 *  handler reasonably needs to decide how to project the result back
 *  into its own output. Kept narrow so the handler API doesn't drag
 *  the full `Run<T>` type into every step file. */
export interface RecursiveDispatchResult {
    runId: string;
    status: 'completed' | 'errored' | 'canceled' | 'running' | 'awaiting_input';
    output?: Record<string, unknown>;
    error?: { code?: string; message?: string; stepId?: string };
}

/** Typed routing — replaces the previously-untyped
 *  `Readonly<Record<string, unknown>>`. Workflow-substrate fields
 *  are explicit; transport-specific metadata lives in `context`. */
export interface HandlerRouting {
    /** Transport that originated this dispatch chain. */
    transport?: 'in-process' | 'mcp' | 'laptop' | 'vm';
    /** UI anchor — top-level runId; propagates AS-IS through every
     *  descendant of a dispatch tree. Transport ports filter events by
     *  this id to render the whole subtree in one surface. */
    surfaceRunId?: string;
    /** Parent run's id (set when this run is a recursive
     *  dispatch — subworkflow step or agent's `execute()` call). */
    parentRunId?: string;
    /** Long-lived conversation continuity key (persistent in-process
     *  conversations). When set, the runner reuses the conversation's
     *  runtime/workdir resources across turns. */
    conversationKey?: string;
    /** Free-form metadata from the caller — slackThreadId,
     *  mcpConvId, cliPid, etc. Subscriber-typed; the engine
     *  doesn't read keys here. */
    context: Readonly<Record<string, unknown>>;
}

// Re-export so callers can import the typed event shapes from the
// same module they import `HandlerContext` from.
export type { TypedFactEvent };
export type { Principal } from '../principal';

/** What a per-kind handler returns.
 *
 *  The two pause variants share one durable mechanism (the engine
 *  parks the run and `resumeRun` re-enters from persisted state — see
 *  `engine/run-graph.ts`); they differ only in who resumes:
 *
 *   - `paused_human` — a person answers a prompt (Slack button / form).
 *   - `paused_signal` — an external system-state change resumes the
 *     run (e.g. a Devin session reaching a terminal state). A durable
 *     worker watches `signalKey` and calls `resumeRun` on transition.
 *     There is no user-facing prompt; the step's own
 *     `fact.component` emit carries any UI. */
export type HandlerResult =
    | { kind: 'completed'; output: unknown }
    | {
          kind: 'paused_human';
          prompt: string;
          routes: string[];
          schema?: unknown;
          /** Agent-authored template materialized with the response on
           *  resume — see `hitl.materializeResumePrompt`. */
          resumePrompt?: string;
      }
    | {
          kind: 'paused_signal';
          /** Identifies the external signal a worker watches to decide
           *  when to resume (e.g. `devin:<sessionId>`). Opaque to the
           *  engine; the dispatching worker owns its meaning. */
          signalKey: string;
          /** Optional JSON-schema the resume value is validated against. */
          schema?: unknown;
          resumePrompt?: string;
      }
    | { kind: 'error'; code: string; message: string; details?: unknown };

export type StepKindHandler<S extends WorkflowStep = WorkflowStep> = (
    step: S,
    ctx: HandlerContext,
) => Promise<HandlerResult>;

// Type aliases for back-references in the lib's own implementation;
// they share the same definitions.
export type StepKindHandlerCtx = HandlerContext;
export type StepKindHandlerResult = HandlerResult;
