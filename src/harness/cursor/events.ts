/**
 * Cursor `SDKMessage` → `HarnessEvent` translator.
 *
 * Source of truth for the Cursor wire shape:
 *   `node_modules/@cursor/sdk/dist/esm/messages.d.ts`
 *     - `SDKSystemMessage` (`type: 'system'`)
 *     - `SDKAssistantMessage` (`type: 'assistant'`, content[text|tool_use])
 *     - `SDKToolUseMessage` (`type: 'tool_call'`, status: running|completed|error)
 *     - `SDKUserMessageEvent` (`type: 'user'`)
 *     - `SDKThinkingMessage` (`type: 'thinking'`)
 *     - `SDKStatusMessage` (`type: 'status'`, status: CREATING|RUNNING|FINISHED|...)
 *     - `SDKTaskMessage` (`type: 'task'`) — subagent task lifecycle
 *
 * Cursor delivers tool calls as **separate `tool_call` events** rather
 * than embedding them inside the assistant turn (CAS does the latter).
 * The translator collapses both shapes into the canonical
 * `tool_call` / `tool_result` pair. The assistant turn still emits an
 * `assistant_message` for text-only content blocks so consumers that
 * key off per-turn boundaries see a stable marker.
 *
 * Per-token deltas come through Cursor's `onDelta` callback, NOT
 * through `stream()` (see Cursor SDK `SendOptions.onDelta`). The
 * `send.ts` glue wires `onDelta` into the translator state so deltas
 * are interleaved with the stream output in roughly the right order.
 */

import type { SDKMessage as CursorSDKMessage, InteractionUpdate, RunStatus as CursorRunStatus } from '@cursor/sdk';
import type { AssistantBlock, HarnessEvent, RunStatus } from '../types';
import { createBaseTranslatorState, mapStream, type BaseTranslatorState } from '../translator-base';

/** Per-stream state needed across rows. Cursor's `tool_call` events
 *  carry the args/result inline; we track in-flight ids (`openToolCalls`)
 *  to emit the matching `tool_result` exactly once. `task` events stamp
 *  subagent start/end (`openSubagents`). All common with cas — the shape
 *  is the shared {@link BaseTranslatorState}. */
export type TranslatorState = BaseTranslatorState;

export function createTranslatorState(): TranslatorState {
    return createBaseTranslatorState();
}

/** Map a Cursor `RunStatus` to canonical `RunStatus`. Cursor's
 *  terminal vocabulary is `finished | error | cancelled`; CAS uses
 *  `completed | errored | canceled`. The `RUNNING` / `CREATING` /
 *  `EXPIRED` mappings preserve information loss intentionally:
 *  `EXPIRED` collapses to `errored` because the canonical taxonomy
 *  doesn't carry a separate "ran past deadline" state. */
export function mapCursorRunStatus(s: CursorRunStatus | string): RunStatus {
    switch (s) {
        case 'running':
        case 'RUNNING':
            return 'running';
        case 'finished':
        case 'FINISHED':
            return 'completed';
        case 'cancelled':
        case 'CANCELLED':
            return 'canceled';
        case 'error':
        case 'ERROR':
        case 'EXPIRED':
            return 'errored';
        case 'CREATING':
            return 'running';
        default:
            return 'running';
    }
}

/**
 * Translate a Cursor SDK stream into the canonical event stream. Lazy
 * — pulls from the source iterator and yields per-row, so consumers
 * keep backpressure end-to-end.
 */
export function mapCursorStream(cursorMessages: AsyncIterable<CursorSDKMessage>, runId: string): AsyncGenerator<HarnessEvent> {
    return mapStream(cursorMessages, runId, createTranslatorState, mapCursorMessage);
}

/**
 * Pure row translator — `events.test.ts` builds inline Cursor message
 * fixtures and asserts the emitted `HarnessEvent[]` per row.
 */
export function mapCursorMessage(msg: CursorSDKMessage, runId: string, state: TranslatorState): HarnessEvent[] {
    switch (msg.type) {
        case 'system':
            return mapSystem(msg, runId, state);
        case 'assistant':
            return mapAssistant(msg, runId);
        case 'user':
            return mapUser(msg, runId);
        case 'tool_call':
            return mapToolCall(msg, runId, state);
        case 'thinking':
            return mapThinking(msg, runId);
        case 'status':
            return mapStatus(msg, runId);
        case 'task':
            return mapTask(msg, runId, state);
        default:
            // `request` and any future variants are silently dropped —
            // canonical taxonomy is intentionally narrower than Cursor's.
            return [];
    }
}

function mapSystem(msg: Extract<CursorSDKMessage, { type: 'system' }>, runId: string, state: TranslatorState): HarnessEvent[] {
    if (msg.subtype === 'init' && !state.sawInit) {
        state.sawInit = true;
        return [{ kind: 'status', status: 'running', runId }];
    }
    return [];
}

function mapAssistant(msg: Extract<CursorSDKMessage, { type: 'assistant' }>, runId: string): HarnessEvent[] {
    const content: AssistantBlock[] = [];
    for (const block of msg.message.content) {
        if (block.type === 'text') {
            content.push({ type: 'text', text: block.text });
        } else if (block.type === 'tool_use') {
            content.push({
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.input,
            });
        }
    }
    return [{ kind: 'assistant_message', content, runId }];
}

function mapUser(msg: Extract<CursorSDKMessage, { type: 'user' }>, _runId: string): HarnessEvent[] {
    // Cursor's `user` events carry only text from the user, not tool
    // results (those flow through `tool_call` with a `result` field).
    // No canonical event for replayed user text inside `stream()` —
    // consumers learn about user input from `agent.send` itself.
    void msg;
    return [];
}

function mapToolCall(msg: Extract<CursorSDKMessage, { type: 'tool_call' }>, runId: string, state: TranslatorState): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const callId = msg.call_id;

    if (msg.status === 'running' && !state.openToolCalls.has(callId)) {
        state.openToolCalls.set(callId, msg.name);
        out.push({
            kind: 'tool_call',
            toolUseId: callId,
            name: msg.name,
            input: msg.args ?? {},
            runId,
        });
        return out;
    }

    // Late-arriving open (some Cursor flows skip a separate `running`
    // event and go straight to `completed`). Emit the call event
    // first so consumers see the canonical pair.
    if (!state.openToolCalls.has(callId) && (msg.status === 'completed' || msg.status === 'error')) {
        state.openToolCalls.set(callId, msg.name);
        out.push({
            kind: 'tool_call',
            toolUseId: callId,
            name: msg.name,
            input: msg.args ?? {},
            runId,
        });
    }

    if (msg.status === 'completed' || msg.status === 'error') {
        out.push({
            kind: 'tool_result',
            toolUseId: callId,
            output: msg.result ?? null,
            isError: msg.status === 'error',
            runId,
        });
        state.openToolCalls.delete(callId);
    }
    return out;
}

function mapThinking(msg: Extract<CursorSDKMessage, { type: 'thinking' }>, runId: string): HarnessEvent[] {
    return [{ kind: 'thinking', text: msg.text, runId }];
}

function mapStatus(msg: Extract<CursorSDKMessage, { type: 'status' }>, runId: string): HarnessEvent[] {
    const status = mapCursorRunStatus(msg.status);
    const out: HarnessEvent[] = [];
    if (status === 'errored' && typeof msg.message === 'string') {
        out.push({
            kind: 'error',
            message: msg.message,
            recoverable: false,
            runId,
        });
    }
    // Only emit terminal statuses on the stream; `running` is the
    // implicit default and the `system: init` already covers the
    // canonical leading marker.
    if (status === 'completed' || status === 'errored' || status === 'canceled') {
        out.push({ kind: 'status', status, runId });
    }
    return out;
}

function mapTask(msg: Extract<CursorSDKMessage, { type: 'task' }>, runId: string, state: TranslatorState): HarnessEvent[] {
    // `SDKTaskMessage` is Cursor's subagent (Task tool) lifecycle
    // marker. `status: 'starting'/'completed'` etc carry a slug-ish
    // text. We collapse to `subagent_started`/`subagent_completed`
    // keyed off the (agent_id, run_id) pair — Cursor doesn't expose a
    // separate sub-run id at this layer.
    const taskId = `${msg.agent_id}:${msg.run_id}`;
    const slug = typeof msg.text === 'string' && msg.text.length > 0 ? msg.text : 'subagent';
    if (msg.status === 'completed' || msg.status === 'finished') {
        if (state.openSubagents.has(taskId)) {
            state.openSubagents.delete(taskId);
            return [
                {
                    kind: 'subagent_completed',
                    slug,
                    subRunId: taskId,
                    parentRunId: runId,
                    result: msg.text ?? null,
                },
            ];
        }
        return [];
    }
    if (!state.openSubagents.has(taskId)) {
        state.openSubagents.set(taskId, slug);
        return [
            {
                kind: 'subagent_started',
                slug,
                subRunId: taskId,
                parentRunId: runId,
            },
        ];
    }
    return [];
}

/**
 * Translate an `InteractionUpdate` from Cursor's `onDelta` callback
 * into a single canonical `assistant_delta` event. `null` if the
 * update isn't a text delta (Cursor also emits tool/thinking deltas
 * through the same callback). Exported so `send.ts` can wire the
 * callback without duplicating the discriminator switch.
 */
export function mapCursorDelta(update: InteractionUpdate, runId: string): HarnessEvent | null {
    // `InteractionUpdate` is a discriminated union; the text-delta
    // shape is `{ type: 'textDelta', text: string }` (per
    // `delta-types.d.ts`'s `TextDeltaUpdate`). We treat any update
    // carrying a `text` string as a delta candidate to be forgiving
    // about minor SDK shape changes.
    const u = update as { type?: string; text?: string };
    if (u.type === 'textDelta' && typeof u.text === 'string') {
        return { kind: 'assistant_delta', text: u.text, runId };
    }
    return null;
}
