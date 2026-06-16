/**
 * Shared scaffolding for the per-backend `events.ts` row translators
 * (F20).
 *
 * Every adapter's translator threads the same minimal state across rows
 * — open tool calls, open subagents, and a one-shot `sawInit` latch —
 * and every adapter builds the same `usage` event with the same
 * optional-field discipline (omit `cacheRead` / `cacheWrite` / `costUsd`
 * when the provider didn't report them, so consumers can tell "missing"
 * from "zero").
 *
 * The big per-backend discriminator switch (provider message →
 * `HarnessEvent`) STAYS in each adapter's `events.ts`; only this common
 * state shape + the usage-event builder + a generic stream-mapper
 * wrapper live here.
 */

import type { HarnessEvent } from './types';

/**
 * Common per-stream translator state. Adapters extend this with
 * backend-only fields and call {@link createBaseTranslatorState} from
 * their own `createTranslatorState`.
 */
export interface BaseTranslatorState {
    /** Tool-use id → tool name. Populated when the `tool_use` /
     *  `tool_call` open is seen; consulted when the matching
     *  `tool_result` arrives. */
    openToolCalls: Map<string, string>;
    /** Open subagent slugs keyed by the backend's sub-run id
     *  (cas: `parent_tool_use_id`; cursor: `agent_id:run_id`). */
    openSubagents: Map<string, string>;
    /** True once the leading `init` row has been seen; the first init
     *  emits `status: running` exactly once. */
    sawInit: boolean;
}

/** Build the common translator-state fields. Adapters spread this and
 *  add their own. */
export function createBaseTranslatorState(): BaseTranslatorState {
    return {
        openToolCalls: new Map(),
        openSubagents: new Map(),
        sawInit: false,
    };
}

/** Numeric fields a `usage` event may carry. `inputTokens` /
 *  `outputTokens` are required; the rest are omitted from the event when
 *  `undefined` so downstream can distinguish "missing" from "zero". */
export interface UsageFields {
    inputTokens: number;
    outputTokens: number;
    cacheRead?: number;
    cacheWrite?: number;
    costUsd?: number;
}

/**
 * Build a canonical `usage` event, centralizing the optional-field rule:
 * `cacheRead` / `cacheWrite` / `costUsd` are included only when a number
 * was supplied. Used by every backend's terminal/usage row mapper.
 */
export function buildUsageEvent(runId: string, fields: UsageFields): Extract<HarnessEvent, { kind: 'usage' }> {
    const ev: Extract<HarnessEvent, { kind: 'usage' }> = {
        kind: 'usage',
        inputTokens: fields.inputTokens,
        outputTokens: fields.outputTokens,
        runId,
    };
    if (typeof fields.cacheRead === 'number') ev.cacheRead = fields.cacheRead;
    if (typeof fields.cacheWrite === 'number') ev.cacheWrite = fields.cacheWrite;
    if (typeof fields.costUsd === 'number') ev.costUsd = fields.costUsd;
    return ev;
}

/**
 * Generic lazy stream-mapper wrapper. Given a per-row translator
 * `mapMessage` and a fresh-state factory, walk a provider source and
 * yield canonical events per row, preserving end-to-end backpressure.
 * Each adapter's `mapXStream` is a one-line specialization of this.
 */
export async function* mapStream<Raw, State>(
    source: AsyncIterable<Raw>,
    runId: string,
    createState: () => State,
    mapMessage: (msg: Raw, runId: string, state: State) => HarnessEvent[],
): AsyncGenerator<HarnessEvent> {
    const state = createState();
    for await (const msg of source) {
        for (const ev of mapMessage(msg, runId, state)) {
            yield ev;
        }
    }
}
