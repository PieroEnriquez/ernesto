/**
 * Per-step-kind handler interface.
 *
 * Mirrors the `StepKindHandlerCtx` / `StepKindHandlerResult` shape the
 * backend's `wire-fragua.ts` declares, but lives here in the lib so the
 * backend can import it from `ernesto/workflow-engine` rather than
 * redeclare a structurally-compatible copy.
 *
 * `routing` is the per-run untyped scratch surface — tier metadata,
 * principal id, scope set, slackThreadId, etc. live in there.
 */

import type { WorkflowStep } from '../../workflows/types';
import type { Component } from '../../components/types';
import type { TypedFactEvent } from './event';

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
          component: Component;
          ts?: number;
      };

export interface HandlerContext {
    runId: string;
    stepId: string;
    routing: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
    log: EngineLogger;
    /** Working tree pinned for this run (route + agent handlers thread
     *  it into ernesto's route ctx). */
    workdirRoot?: string;
    /** Publish a step-scoped fact event onto the run's event stream.
     *  Pre-bound to the current step by the walker — handlers that
     *  ignore this just lose mid-step granularity (lifecycle events
     *  still flow through the walker). */
    emit?: EmitFactEvent;
}

// Re-export so callers can import the typed event shapes from the
// same module they import `HandlerContext` from.
export type { TypedFactEvent };

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

// Legacy aliases kept for the backend shim's type import path.
export type StepKindHandlerCtx = HandlerContext;
export type StepKindHandlerResult = HandlerResult;
