/**
 * Shared types for the `ui-tools/` in-process MCP server.
 *
 * Each `ui.<kind>` tool handler is invoked with a `UiToolContext`
 * built by the server at tool-call time. The context carries the
 * canonical `runId` + `stepId` plus the two side-effect surfaces:
 *
 *   - `emit` — publishes a `fact.component` event into the workflow
 *     engine's bus + store. Bound by the walker to the originating
 *     `(runId, stepId)` so handlers don't have to re-thread routing.
 *   - `hitl` — exposes `pauseForHuman` for the input-shaped tool
 *     (`ui.input`). The handler awaits the resume call and returns
 *     the user's answer as the tool result; the LLM consumes that
 *     as if the tool returned synchronously.
 */

import type { EmitFactEvent } from '../workflow-engine/types/handler';
import type { HitlPauseInput } from '../workflow-engine/hitl';

/** Narrow pause primitive — what the input-shaped UI handlers need
 *  from the runner's HITL surface. Structurally satisfied by
 *  `HitlController` and by `WorkflowRunner.pauseForHuman`. */
export interface UiHitlPauser {
    pauseForHuman(input: HitlPauseInput): Promise<unknown>;
}

/** Per-tool-call context. Constructed by the server from the walker-
 *  bound `HandlerContext.emit` + the runner's `HitlController` (or
 *  any structural `UiHitlPauser`). */
export interface UiToolContext {
    runId: string;
    stepId: string;
    emit: EmitFactEvent;
    hitl: UiHitlPauser;
}

/** Non-input tools return a brief confirmation; input tools return the
 *  user's response (post-`resumeRun`). Typed as `unknown` at the tool
 *  boundary so the MCP server can serialize whatever the handler
 *  produces without leaking each handler's concrete return type. */
export type UiToolResult = { ok: true } | string | string[] | Record<string, unknown>;
