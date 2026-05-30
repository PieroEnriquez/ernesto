/**
 * `SDKMessage` → `HarnessEvent` translator.
 *
 * This is the only place in the lib that knows about CAS-native event
 * shapes; the table from
 * `agent-ops://harness-abstraction/event-mapping.md` is implemented
 * here verbatim.
 *
 * Ordering invariants enforced (see event-mapping.md "Ordering
 * invariants"):
 *   - `tool_call` precedes its matching `tool_result`.
 *   - `subagent_started` precedes every event with the matching
 *     `subRunId`; `subagent_completed` closes it.
 *   - `usage` per turn fires after `assistant_message`, before the next
 *     turn's first event.
 *   - `status: completed` is the LAST event on any successful stream.
 *   - `error` always emits `status: errored` immediately after.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
    AssistantBlock,
    HarnessEvent,
} from '../types';
import {
    buildUsageEvent,
    createBaseTranslatorState,
    mapStream,
    type BaseTranslatorState,
} from '../translator-base';

/**
 * Per-stream state the row translator needs across rows. Tracks open
 * tool calls (to know which `tool_result` is in-flight) and active
 * subagent contexts (keyed by `parent_tool_use_id`).
 *
 * The common fields live on {@link BaseTranslatorState}; CAS adds none
 * of its own today (the shape is fully shared with cursor), but keeping
 * the alias documents the seam and leaves room for CAS-only fields.
 */
export type TranslatorState = BaseTranslatorState;

export function createTranslatorState(): TranslatorState {
    return createBaseTranslatorState();
}

/**
 * Translate a CAS SDK stream into the canonical harness event stream.
 * Lazy — pulls from the source iterator and yields per-row, so consumers
 * keep backpressure end-to-end.
 */
export function mapSdkStream(
    sdkMessages: AsyncIterable<SDKMessage>,
    runId: string,
): AsyncGenerator<HarnessEvent> {
    return mapStream(sdkMessages, runId, createTranslatorState, mapSdkMessage);
}

/**
 * Pure row translator. Exported for testability — `events.test.ts`
 * builds inline SDK message fixtures and asserts the emitted
 * `HarnessEvent[]` for each row independently.
 */
export function mapSdkMessage(
    msg: SDKMessage,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    switch (msg.type) {
        case 'system':
            return mapSystem(msg, runId, state);
        case 'assistant':
            return mapAssistant(msg, runId, state);
        case 'user':
            return mapUser(msg, runId, state);
        case 'stream_event':
            return mapStreamEvent(msg, runId);
        case 'result':
            return mapResult(msg, runId);
        default:
            // Drop all other SDK message variants — they are CAS-internal
            // (auth status, rate limit events, hook progress, etc.) and
            // not part of the canonical event taxonomy.
            return [];
    }
}

function mapSystem(
    msg: Extract<SDKMessage, { type: 'system' }>,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    if (msg.subtype === 'init' && !state.sawInit) {
        state.sawInit = true;
        return [{ kind: 'status', status: 'running', runId }];
    }
    return [];
}

function mapAssistant(
    msg: Extract<SDKMessage, { type: 'assistant' }>,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const parentToolUseId = msg.parent_tool_use_id ?? null;

    // Subagent forwarding: emit `subagent_started` the first time we
    // see a message stamped with a `parent_tool_use_id` we haven't
    // observed yet. The slug comes from the SDK's `subagent_type`
    // hint when present, otherwise fall back to the tool-use id.
    if (parentToolUseId && !state.openSubagents.has(parentToolUseId)) {
        const slug = msg.subagent_type ?? 'subagent';
        state.openSubagents.set(parentToolUseId, slug);
        out.push({
            kind: 'subagent_started',
            slug,
            subRunId: parentToolUseId,
            parentRunId: runId,
        });
    }

    const contentBlocks: AssistantBlock[] = [];
    const rawContent = msg.message.content;
    if (Array.isArray(rawContent)) {
        for (const block of rawContent) {
            const b = block as unknown as { type?: string } & Record<string, unknown>;
            if (b.type === 'text') {
                const text = typeof b.text === 'string' ? b.text : '';
                contentBlocks.push({ type: 'text', text });
            } else if (b.type === 'tool_use') {
                const id = typeof b.id === 'string' ? b.id : '';
                const name = typeof b.name === 'string' ? b.name : '';
                const input = (b.input as unknown) ?? {};
                contentBlocks.push({ type: 'tool_use', id, name, input });
                state.openToolCalls.set(id, name);
                out.push({
                    kind: 'tool_call',
                    toolUseId: id,
                    name,
                    input,
                    runId,
                });
            } else if (b.type === 'thinking') {
                const text = typeof b.thinking === 'string'
                    ? b.thinking
                    : typeof b.text === 'string'
                        ? b.text
                        : '';
                out.push({ kind: 'thinking', text, runId });
                // `thinking` blocks are *not* re-included in
                // `assistant_message.content` — they have their own
                // event. (event-mapping.md row "Full assistant turn".)
            }
            // Unknown block types are silently dropped — the canonical
            // shape is intentionally narrower than CAS's content union.
        }
    }

    // Insertion order: tool_call events were appended as we iterated
    // content blocks; assistant_message is emitted last so consumers
    // that key off `assistant_message` see a stable per-turn marker
    // after all per-block events.
    out.push({
        kind: 'assistant_message',
        content: contentBlocks,
        runId,
    });
    return out;
}

function mapUser(
    msg: Extract<SDKMessage, { type: 'user' }>,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const rawContent = msg.message.content as unknown;
    if (!Array.isArray(rawContent)) return out;

    for (const block of rawContent) {
        const b = block as { type?: string } & Record<string, unknown>;
        if (b.type === 'tool_result') {
            const toolUseId =
                typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
            const output = b.content as unknown;
            const isError = b.is_error === true;
            out.push({
                kind: 'tool_result',
                toolUseId,
                output,
                isError,
                runId,
            });

            // Subagent close: if this tool_result matches an open
            // subagent (the original Task call lives in `openToolCalls`
            // and `openSubagents` keys on the same id), emit
            // `subagent_completed`.
            const slug = state.openSubagents.get(toolUseId);
            if (slug !== undefined) {
                out.push({
                    kind: 'subagent_completed',
                    slug,
                    subRunId: toolUseId,
                    parentRunId: runId,
                    result: output,
                });
                state.openSubagents.delete(toolUseId);
            }
            state.openToolCalls.delete(toolUseId);
        }
    }
    return out;
}

function mapStreamEvent(
    msg: Extract<SDKMessage, { type: 'stream_event' }>,
    runId: string,
): HarnessEvent[] {
    const ev = msg.event as { type?: string } & Record<string, unknown>;
    // Per-token text delta — the only stream_event shape we surface.
    // `tool_use` / `thinking` block deltas are skipped; they re-emerge
    // through the full `assistant` turn instead (event-mapping.md row
    // "Per-block delta").
    if (ev.type === 'content_block_delta') {
        const delta = ev.delta as { type?: string; text?: string } | undefined;
        if (delta && delta.type === 'text_delta' && typeof delta.text === 'string') {
            return [{ kind: 'assistant_delta', text: delta.text, runId }];
        }
    }
    return [];
}

function mapResult(
    msg: Extract<SDKMessage, { type: 'result' }>,
    runId: string,
): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const usage = msg.usage;
    const inputTokens =
        ((usage as { input_tokens?: number } | undefined)?.input_tokens) ?? 0;
    const outputTokens =
        ((usage as { output_tokens?: number } | undefined)?.output_tokens) ?? 0;
    const cacheRead =
        ((usage as { cache_read_input_tokens?: number } | undefined)
            ?.cache_read_input_tokens) ?? undefined;
    const cacheWrite =
        ((usage as { cache_creation_input_tokens?: number } | undefined)
            ?.cache_creation_input_tokens) ?? undefined;
    const costUsd =
        typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined;

    // `usage` fires AFTER `assistant_message`, BEFORE the next event.
    // For terminal results, it fires just before `status: completed` /
    // `status: errored`. `buildUsageEvent` centralizes the
    // optional-field rule (omit cacheRead/cacheWrite/costUsd when absent).
    out.push(
        buildUsageEvent(runId, {
            inputTokens,
            outputTokens,
            cacheRead,
            cacheWrite,
            costUsd,
        }),
    );

    if (msg.subtype === 'success') {
        out.push({ kind: 'status', status: 'completed', runId });
        return out;
    }

    // Error subtypes: `error_during_execution`, `error_max_turns`,
    // `error_max_budget_usd`, `error_max_structured_output_retries`.
    // The SDK doesn't expose a 'cancelled' subtype on the result —
    // cancellation is surfaced via `Query.interrupt()` resolving, and
    // the caller emits `status: canceled` separately in `send.ts`.
    const errors = (msg as { errors?: unknown }).errors;
    const message = Array.isArray(errors) && typeof errors[0] === 'string'
        ? errors[0]
        : `CAS run ${msg.subtype}`;
    out.push({ kind: 'error', message, recoverable: false, runId });
    out.push({ kind: 'status', status: 'errored', runId });
    return out;
}
