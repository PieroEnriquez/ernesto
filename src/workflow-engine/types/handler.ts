/**
 * Per-step-kind handler interface.
 *
 * Each step kind's handler receives a typed `HandlerContext` carrying
 * the principal (user vs service), the typed routing surface
 * (tier/surfaceRunId/parentRunId/conversationKey + free-form context),
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
           *  per-tier subscribers translate to native UI. */
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
     * `tier`, `parentRunId`, `surfaceRunId`, `conversationKey`,
     * plus the originating caller's free-form `context` blob for
     * tier-port-specific metadata. Step handlers thread these
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
}

/** Typed routing — replaces the previously-untyped
 *  `Readonly<Record<string, unknown>>`. Workflow-substrate fields
 *  are explicit; tier-port-specific metadata lives in `context`. */
export interface HandlerRouting {
    /** Tier port that originated this dispatch chain. */
    tier?: 'A' | 'B' | 'C';
    /** UI anchor — top-level runId; propagates AS-IS through every
     *  descendant of a dispatch tree. Tier ports filter events by
     *  this id to render the whole subtree in one surface. */
    surfaceRunId?: string;
    /** Parent run's id (set when this run is a recursive
     *  dispatch — subworkflow step or agent's `execute()` call). */
    parentRunId?: string;
    /** Long-lived conversation continuity key (workspace-tier
     *  sessions). When set, the runner reuses session resources. */
    conversationKey?: string;
    /** Free-form metadata from the caller — slackThreadId,
     *  claudeAiConvId, cliPid, etc. Subscriber-typed; the engine
     *  doesn't read keys here. */
    context: Readonly<Record<string, unknown>>;
}

// Re-export so callers can import the typed event shapes from the
// same module they import `HandlerContext` from.
export type { TypedFactEvent };
export type { Principal } from '../principal';

/** What a per-kind handler returns. */
export type HandlerResult =
    | { kind: 'completed'; output: unknown }
    | {
          kind: 'paused_human';
          prompt: string;
          routes: string[];
          schema?: unknown;
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
