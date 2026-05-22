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

/** Logger surface — matches the backend's `RouteLogger`. */
export interface EngineLogger {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
}

export interface HandlerContext {
    runId: string;
    stepId: string;
    routing: Readonly<Record<string, unknown>>;
    signal: AbortSignal;
    log: EngineLogger;
    /** Working tree pinned for this run (route + agent handlers thread
     *  it into ernesto's route ctx). */
    workdirRoot?: string;
}

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
