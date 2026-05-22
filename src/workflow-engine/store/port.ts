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
    listRuns(opts?: ListRunsOpts): Promise<RunSummary[]>;
}

export type { StoredEvent };
