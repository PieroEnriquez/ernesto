/**
 * Run-state + event-log persistence port. The default
 * `InMemoryStore` is a Map+array impl suitable for tests and the
 * Phase 0 in-process deployment. Production backends swap in a
 * Postgres/SQLite-backed implementation against the same port.
 */

import type { StoredEvent } from '../types/event';

export type RunStatus =
    | 'running'
    | 'paused'
    | 'completed'
    | 'errored'
    | 'aborted';

/** A single step parked on a step-level pause, awaiting `resumeRun`.
 *  Persisted inside {@link ResumeState} so a fresh process (after a
 *  pod restart, or a worker in another pod) can re-enter the run
 *  without an in-heap promise. */
export interface ParkedPause {
    /** Full node id (path-prefixed) of the parked step — the seed key
     *  the resume re-walk resolves against. */
    stepId: string;
    /** Per-pause id; the resume target. One run may park several. */
    promptId: string;
    /** `human` — a person answers (Slack button/form); `signal` — an
     *  external system-state change resumes (durable worker). */
    kind: 'human' | 'signal';
    /** JSON-schema the resume value is validated against (optional). */
    schema?: Record<string, unknown>;
    prompt?: string;
    routes?: string[];
    resumePrompt?: string;
    /** Signal-pause only — the external signal a worker watches. */
    signalKey?: string;
}

/** Durable resume state captured when a run parks on a step-level
 *  pause. Lets `resumeRun` continue the DAG from a fresh process: the
 *  re-walk seeds already-completed step outputs, re-applies skips, and
 *  resolves the parked step with the submitted value. Keyed by FULL
 *  node id (path-prefixed) so nested `group` steps re-seed correctly. */
export interface ResumeState {
    /** Completed step outputs at pause time (full node id → output). */
    outputs: Record<string, unknown>;
    /** Skipped step node ids at pause time. */
    skipped: string[];
    /** Steps currently parked, awaiting resume. */
    paused: ParkedPause[];
}

export interface RunState {
    runId: string;
    /** Workflow slug. */
    workflow: string;
    status: RunStatus;
    inputs: Record<string, unknown>;
    routing: Record<string, unknown>;
    startedAt: number;
    endedAt?: number;
    error?: { message: string; stack?: string };
    /** Present iff `status === 'paused'` on a step-level pause —
     *  the durable continuation point for `resumeRun`. */
    resume?: ResumeState;
}

export interface RunSummary {
    runId: string;
    workflow: string;
    status: RunStatus;
    startedAt: number;
    endedAt?: number;
}

export interface ListRunsOpts {
    status?: RunStatus;
    limit?: number;
}

export interface ListEventsOpts {
    /** Return events whose seq is strictly greater than this value. */
    sinceSeq?: number;
}

export interface StorePort {
    appendEvent(event: Omit<StoredEvent, 'seq'>): Promise<StoredEvent>;
    listEvents(runId: string, opts?: ListEventsOpts): Promise<StoredEvent[]>;
    getRunState(runId: string): Promise<RunState | null>;
    putRunState(state: RunState): Promise<void>;
    /** Operator/debug surface only — no runtime dispatch caller (the
     *  hot path uses listEvents/getRunState). Kept for run-history
     *  tooling; a new StorePort impl may stub it if unused. */
    listRuns(opts?: ListRunsOpts): Promise<RunSummary[]>;
}

export type { StoredEvent };
