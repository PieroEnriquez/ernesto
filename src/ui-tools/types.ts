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

import type { AttachmentComponent } from '../components/types';
import type { EmitFactEvent } from '../workflow-engine/types/handler';
import type { HitlPauseInput } from '../workflow-engine/hitl';

/** Narrow pause primitive — what the input-shaped UI handlers need
 *  from the runner's HITL surface. Structurally satisfied by
 *  `HitlController` and by `WorkflowRunner.pauseForHuman`. */
export interface UiHitlPauser {
    pauseForHuman(input: HitlPauseInput): Promise<unknown>;
}

/** Result of an attachment-transformer hook (see `UiToolContext.
 *  transformAttachment`). `ok: true` may carry a rewritten component
 *  the handler should emit in place of the original (e.g.
 *  rasterized SVG → PNG); `ok: false` surfaces a per-attachment
 *  error in the tool result so the agent receives it synchronously
 *  and can retry with a different shape. */
export type AttachmentTransformResult =
    | { ok: true; component?: AttachmentComponent }
    | { ok: false; error: string };

/** Optional pre-emit hook for `attachment` components. The lib calls
 *  this after structural validation but before `fact.component` is
 *  emitted — so a per-tier rewrite (e.g. Slack's SVG → PNG
 *  rasterization) can surface as a tool-result error the agent can
 *  react to in the same turn. Hooks must not throw; return
 *  `{ok: false, error}` for any failure surface. */
export type AttachmentTransformer = (
    component: AttachmentComponent,
) => Promise<AttachmentTransformResult>;

/** Per-tool-call context. Constructed by the server from the walker-
 *  bound `HandlerContext.emit` + the runner's `HitlController` (or
 *  any structural `UiHitlPauser`). */
export interface UiToolContext {
    runId: string;
    stepId: string;
    emit: EmitFactEvent;
    hitl: UiHitlPauser;
    /** Absolute path to the run's workdir root. When set, the `ui`
     *  tool accepts `{ref: 'path/to/file.json'}` — the handler reads
     *  the file as the UI definition. Path is resolved against this
     *  root with `..`-segment rejection + outside-workdir guard so the
     *  agent can't escape its sandbox. Omitted in contexts that don't
     *  allocate a workdir (tests, ad-hoc CLI dispatches); `{ref}` then
     *  fails with `ref_unsupported`. */
    workdirRoot?: string;
    /** Per-tier hook for transforming `attachment` components before
     *  emit. Failures land in the tool result as per-component
     *  errors so the agent can react in the same turn. Use case:
     *  Slack rasterizes SVG → PNG and reports failures (invalid SVG,
     *  unsupported features, size cap) up to the agent. */
    transformAttachment?: AttachmentTransformer;
}

/** Non-input tools return a brief confirmation; input tools return the
 *  user's response (post-`resumeRun`). Typed as `unknown` at the tool
 *  boundary so the MCP server can serialize whatever the handler
 *  produces without leaking each handler's concrete return type. */
export type UiToolResult = { ok: true } | string | string[] | Record<string, unknown>;
