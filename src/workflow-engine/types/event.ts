/**
 * Fact-event taxonomy emitted by the runner. Mirrors fragua's
 * `fact.*` taxonomy so the existing `wire-fragua.ts` translator
 * (`translateFactEvent`) keeps working without modification.
 */

/** Bus event delivered to subscribers; identical to fragua's
 *  `RawFraguaFactEvent` so the backend's existing event-bridge
 *  translator works unchanged. */
export interface FactEvent {
    runId: string;
    seq: number;
    /** Fact event types per fragua's taxonomy (`fact.run_started`,
     *  `fact.run_paused_human`, `fact.node_completed`, …). */
    type: string;
    payload: Record<string, unknown>;
    ts: number;
    /** Per-run untyped routing blob (tier, scopes, parentRunId, …). */
    routing?: Readonly<Record<string, unknown>>;
}

/** Persisted form of a fact-event — adds a monotonic store-side seq
 *  and writer attribution for audit. */
export interface StoredEvent {
    runId: string;
    seq: number;
    type: string;
    writer: 'engine' | 'handler' | 'subscriber';
    payload: unknown;
    ts: number;
    routing?: Readonly<Record<string, unknown>>;
}

/** Legacy alias for the backend shim — the fragua-flavored name maps
 *  1:1 to `FactEvent`. */
export type FraguaFactEvent = FactEvent;
