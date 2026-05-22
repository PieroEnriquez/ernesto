/**
 * Public runner surface — the shape `wire-fragua.ts` calls into
 * (`FraguaInstance`). Authored here in the lib so the backend's
 * structural interface can simply re-export this type.
 */

import type { StepKind } from '../../workflows/types';
import type { StepKindHandler } from './handler';
import type { FactEvent } from './event';
import type { WorkflowReader } from '../workflow-reader';
import type { HitlPauseInput } from '../hitl';

export interface SubscribeEventsOpts {
    lastEventId?: string;
    onEvent: (raw: FactEvent) => void;
    onError?: (err: Error) => void;
}

export interface EventSubscription {
    close(): Promise<void>;
}

export interface DispatchWorkflowInput {
    /** Workflow slug (resolved against the workflow registry). */
    slug: string;
    /** Inputs passed to the run's `inputs:` block. */
    inputs: Record<string, unknown>;
    /** Caller's principal — `userId` + scope set already narrowed by
     *  §7.4 inside the subworkflow handler. */
    principal: { userId: string; scopes: ReadonlySet<string> };
    /** Per-run context — tier, parentRunId, slackThreadId, etc. */
    context: Record<string, unknown>;
    signal?: AbortSignal;
}

export interface DispatchWorkflowResult {
    runId: string;
    outputs: Record<string, unknown>;
    status: 'completed' | 'errored' | 'canceled' | 'paused';
}

/** Resume intent supplied by a HITL submitter. */
export interface ResumeRunInput {
    runId: string;
    promptId: string;
    value: unknown;
}

/** The runner surface. The backend's `FraguaInstance` is structurally
 *  this exact shape. */
export interface WorkflowRunner {
    registerStepKind(kind: StepKind, handler: StepKindHandler<any>): void;
    registerWorkflowReader(reader: WorkflowReader): void;
    subscribeEvents(opts: SubscribeEventsOpts): Promise<EventSubscription>;
    dispatchWorkflow(
        input: DispatchWorkflowInput,
    ): Promise<DispatchWorkflowResult>;
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
