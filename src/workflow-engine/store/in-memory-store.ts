/**
 * In-memory `StorePort` impl. Single-process, no durability. Suitable
 * for tests and the Phase 0 in-process runner.
 *
 * Each run owns a monotonic event seq starting at 0. The store
 * assigns the seq on append; callers don't pre-allocate.
 */

import type { ListEventsOpts, ListRunsOpts, RunState, RunStatus, RunSummary, StorePort } from './port';
import type { StoredEvent } from '../types/event';

export class InMemoryStore implements StorePort {
    private readonly events = new Map<string, StoredEvent[]>();
    private readonly runs = new Map<string, RunState>();

    async appendEvent(event: Omit<StoredEvent, 'seq'>): Promise<StoredEvent> {
        const arr = this.events.get(event.runId) ?? [];
        const seq = arr.length;
        const stored: StoredEvent = { ...event, seq };
        arr.push(stored);
        this.events.set(event.runId, arr);
        return stored;
    }

    async listEvents(runId: string, opts: ListEventsOpts = {}): Promise<StoredEvent[]> {
        const arr = this.events.get(runId) ?? [];
        if (opts.sinceSeq === undefined) return [...arr];
        return arr.filter((e) => e.seq > opts.sinceSeq!);
    }

    async getRunState(runId: string): Promise<RunState | null> {
        const state = this.runs.get(runId);
        return state ? { ...state } : null;
    }

    async putRunState(state: RunState): Promise<void> {
        this.runs.set(state.runId, { ...state });
    }

    async listRuns(opts: ListRunsOpts = {}): Promise<RunSummary[]> {
        const filtered: RunSummary[] = [];
        for (const state of this.runs.values()) {
            if (opts.status && state.status !== opts.status) continue;
            filtered.push({
                runId: state.runId,
                workflow: state.workflow,
                status: state.status,
                startedAt: state.startedAt,
                ...(state.endedAt !== undefined ? { endedAt: state.endedAt } : {}),
            });
        }
        // Newest-first by startedAt; deterministic for tests.
        filtered.sort((a, b) => b.startedAt - a.startedAt);
        if (opts.limit !== undefined) return filtered.slice(0, opts.limit);
        return filtered;
    }

    /** Test helper: drop everything. Not on the public port. */
    reset(): void {
        this.events.clear();
        this.runs.clear();
    }
}

export type { RunStatus };
