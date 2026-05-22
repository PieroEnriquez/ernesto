/**
 * pi-agent-core `AgentEvent` → `HarnessEvent` translator.
 *
 * Source of truth for the wire shape:
 *   `node_modules/@mariozechner/pi-agent-core/dist/types.d.ts`
 *     - `AgentEvent` (the 9-variant union: agent_start, agent_end,
 *       turn_start, turn_end, message_start, message_update,
 *       message_end, tool_execution_start, tool_execution_update,
 *       tool_execution_end)
 *     - `AgentMessage` (= pi-ai `Message` | declaration-merged custom
 *       app messages)
 *   `node_modules/@mariozechner/pi-ai/dist/types.d.ts`
 *     - `AssistantMessage` (content: TextContent | ThinkingContent |
 *       ToolCall; carries `usage`, `stopReason`, `errorMessage`)
 *     - `ToolResultMessage` (carries `isError`, `content`, `details`)
 *     - `AssistantMessageEvent` (text_delta, thinking_delta, etc — the
 *       per-token stream pi-agent-core wraps via `message_update`)
 *
 * Conservative defaults per the spec (capabilities.md fragua column):
 *
 * - **Per-token assistant deltas.** pi-agent-core emits `message_update`
 *   carrying an `AssistantMessageEvent` whose `text_delta` variant has
 *   the per-token text. We forward those as canonical
 *   `assistant_delta` events. The matrix's prediction
 *   (`perTokenDeltas: false`) is **wrong** at the pi-agent-core layer:
 *   text is streamed token-by-token through `message_update`. Flag is
 *   flipped to `true` in `index.ts` and documented as a matrix
 *   correction in the step-3 report.
 *
 * - **Thinking blocks.** Same path as text deltas: surfaced through
 *   `message_update` with `thinking_delta`. We emit a single
 *   `thinking` event per full block (collapsing deltas) to mirror what
 *   CAS does — per-block `thinking` rather than per-token. Per-token
 *   thinking would need a new `thinking_delta` variant on the canonical
 *   taxonomy.
 *
 * - **Usage / cost.** pi-ai stamps the final `AssistantMessage` with
 *   `usage` (input/output/cacheRead/cacheWrite + cost breakdown). One
 *   terminal `usage` event per `message_end` of an assistant turn.
 *
 * - **Subagents.** pi-agent-core doesn't expose nested-run lifecycle
 *   directly — fragua-the-project synthesises subagent semantics at
 *   the workflow-engine layer (subworkflow nodes → child runs).
 *   At the harness layer there's no `subagent_*` to emit. The
 *   capability flag (`subagents: true`) in the doc reflects the
 *   workflow-engine reality; the harness adapter cannot fulfil it on
 *   its own and emits no `subagent_*` events. **Flag should be `false`
 *   at the harness layer.** Documented in the step-3 report.
 *
 * - **HITL.** No pi-agent-core surface for HITL prompts. Same story as
 *   subagents — fragua's intent endpoint provides HITL at the
 *   workflow-engine layer, not at the pi-ai layer. **Flag should be
 *   `false` at the harness layer.**
 */

import type {
    AgentEvent,
    AgentMessage,
} from '@mariozechner/pi-agent-core';
import type {
    AssistantMessage,
    AssistantMessageEvent,
    ToolCall as PiToolCall,
    ToolResultMessage,
} from '@mariozechner/pi-ai';
import type {
    AssistantBlock,
    HarnessEvent,
    RunStatus,
} from '../types';

/** Per-stream state needed across rows. We track tool-call ids opened
 *  by the assistant turn so the matching `tool_execution_end` can emit
 *  a paired `tool_result` even when the pi-ai SDK delivers the tool
 *  result as its own `ToolResultMessage` artifact later.
 *
 *  We also stash the leading `agent_start` so a `running` status
 *  fires exactly once at the head of the stream — same idempotence
 *  rule as the Cursor adapter's `sawInit`. */
export interface TranslatorState {
    /** Tool-call ids opened by `tool_execution_start`, mapped to the
     *  tool name. Dropped on the matching `tool_execution_end`. */
    openToolCalls: Map<string, string>;
    /** True after the leading `status: running` has been emitted. */
    sawAgentStart: boolean;
    /** Set of `message_end` assistant message ids whose `usage` event
     *  has been emitted. Defensive against duplicate `message_end`
     *  events from pi-agent-core (shouldn't happen, but keeps the
     *  stream idempotent if it does). */
    usageEmitted: WeakSet<AssistantMessage>;
}

export function createTranslatorState(): TranslatorState {
    return {
        openToolCalls: new Map(),
        sawAgentStart: false,
        usageEmitted: new WeakSet(),
    };
}

/** Map pi-ai's `StopReason` to canonical `RunStatus`. pi-ai uses
 *  `stop | length | toolUse | error | aborted`; we collapse:
 *  `stop` / `length` / `toolUse` → `completed`; `error` → `errored`;
 *  `aborted` → `canceled`. */
export function mapStopReason(s: string | undefined): RunStatus {
    switch (s) {
        case 'error':
            return 'errored';
        case 'aborted':
            return 'canceled';
        case 'stop':
        case 'length':
        case 'toolUse':
            return 'completed';
        default:
            return 'completed';
    }
}

/**
 * Translate a pi-agent-core `AgentEvent` stream into the canonical
 * `HarnessEvent` stream. The source isn't a plain `AsyncIterable` —
 * pi-agent-core delivers events via `Agent.subscribe(listener)`. The
 * `send.ts` glue pumps `agent.subscribe` events into a buffer; this
 * function exists for tests + the rare consumer that holds an
 * already-collected event sequence.
 */
export async function* mapPiAgentStream(
    events: AsyncIterable<AgentEvent>,
    runId: string,
): AsyncGenerator<HarnessEvent> {
    const state = createTranslatorState();
    for await (const ev of events) {
        for (const out of mapPiAgentEvent(ev, runId, state)) {
            yield out;
        }
    }
}

/**
 * Pure row translator — `events.test.ts` builds inline fixtures and
 * asserts the emitted `HarnessEvent[]` per row. The same translator is
 * driven by `send.ts`'s `agent.subscribe` callback.
 */
export function mapPiAgentEvent(
    ev: AgentEvent,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    switch (ev.type) {
        case 'agent_start':
            return mapAgentStart(runId, state);
        case 'agent_end':
            return mapAgentEnd(ev, runId);
        case 'turn_start':
        case 'turn_end':
            // Per-turn brackets are internal to pi-agent-core's loop;
            // the canonical taxonomy doesn't expose a `turn_*` variant.
            // Consumers infer turn boundaries from `assistant_message`
            // + `tool_result` pairs.
            return [];
        case 'message_start':
            return [];
        case 'message_update':
            return mapMessageUpdate(ev, runId);
        case 'message_end':
            return mapMessageEnd(ev, runId, state);
        case 'tool_execution_start':
            return mapToolExecutionStart(ev, runId, state);
        case 'tool_execution_update':
            // Streaming partial tool results — no canonical variant.
            return [];
        case 'tool_execution_end':
            return mapToolExecutionEnd(ev, runId, state);
        default:
            return [];
    }
}

function mapAgentStart(runId: string, state: TranslatorState): HarnessEvent[] {
    if (state.sawAgentStart) return [];
    state.sawAgentStart = true;
    return [{ kind: 'status', status: 'running', runId }];
}

function mapAgentEnd(
    ev: Extract<AgentEvent, { type: 'agent_end' }>,
    runId: string,
): HarnessEvent[] {
    // Pull the terminal status from the trailing assistant message's
    // `stopReason`. A run that ended on a tool result still has the
    // assistant message we want one step back; walk from the tail.
    let terminal: RunStatus = 'completed';
    let errorMessage: string | undefined;
    for (let i = ev.messages.length - 1; i >= 0; i--) {
        const m = ev.messages[i] as AgentMessage;
        if (isAssistantMessage(m)) {
            terminal = mapStopReason(m.stopReason);
            if (m.stopReason === 'error' && m.errorMessage) {
                errorMessage = m.errorMessage;
            }
            break;
        }
    }
    const out: HarnessEvent[] = [];
    if (terminal === 'errored' && errorMessage !== undefined) {
        out.push({
            kind: 'error',
            message: errorMessage,
            recoverable: false,
            runId,
        });
    }
    out.push({ kind: 'status', status: terminal, runId });
    return out;
}

function mapMessageUpdate(
    ev: Extract<AgentEvent, { type: 'message_update' }>,
    runId: string,
): HarnessEvent[] {
    const inner = ev.assistantMessageEvent as AssistantMessageEvent;
    // `text_delta` is the per-token text stream.
    if (inner.type === 'text_delta' && typeof inner.delta === 'string') {
        return [{ kind: 'assistant_delta', text: inner.delta, runId }];
    }
    // pi-ai's `thinking_delta` variant streams reasoning tokens. The
    // canonical taxonomy has no per-token thinking event, so we drop
    // these and surface the full block at `message_end` instead. The
    // alternative — emit one `thinking` per delta — would multiply
    // thinking events by ~50x and break consumers that key off
    // per-block boundaries.
    return [];
}

function mapMessageEnd(
    ev: Extract<AgentEvent, { type: 'message_end' }>,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    const message = ev.message as AgentMessage;
    if (isAssistantMessage(message)) {
        return mapAssistantMessage(message, runId, state);
    }
    if (isToolResultMessage(message)) {
        return mapToolResultMessage(message, runId, state);
    }
    // user / custom messages: no canonical mid-stream event (user
    // input is the caller's `send()`; custom messages are UI-only).
    return [];
}

function mapAssistantMessage(
    msg: AssistantMessage,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const blocks: AssistantBlock[] = [];
    const thinking: string[] = [];
    for (const block of msg.content) {
        if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text });
        } else if (block.type === 'thinking') {
            thinking.push(block.thinking);
            // Thinking blocks become their own `thinking` event so
            // consumers can render them separately from the assistant
            // text.
        } else if (block.type === 'toolCall') {
            const call = block as PiToolCall;
            blocks.push({
                type: 'tool_use',
                id: call.id,
                name: call.name,
                input: call.arguments ?? {},
            });
        }
    }
    if (thinking.length > 0) {
        out.push({ kind: 'thinking', text: thinking.join('\n'), runId });
    }
    if (blocks.length > 0) {
        out.push({ kind: 'assistant_message', content: blocks, runId });
    }
    // Emit one `usage` event per assistant message. `cost.total` is
    // pi-ai's USD figure across input/output/cache.
    if (msg.usage && !state.usageEmitted.has(msg)) {
        state.usageEmitted.add(msg);
        const u = msg.usage;
        const event: Extract<HarnessEvent, { kind: 'usage' }> = {
            kind: 'usage',
            inputTokens: u.input,
            outputTokens: u.output,
            runId,
        };
        if (typeof u.cacheRead === 'number') event.cacheRead = u.cacheRead;
        if (typeof u.cacheWrite === 'number') event.cacheWrite = u.cacheWrite;
        if (u.cost && typeof u.cost.total === 'number') {
            event.costUsd = u.cost.total;
        }
        out.push(event);
    }
    return out;
}

function mapToolResultMessage(
    msg: ToolResultMessage,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    // We may not have seen `tool_execution_end` (the high-level
    // `message_end` of a tool-result message can arrive without one in
    // some pi-agent-core paths) — emit the canonical `tool_result`
    // directly here when the slot is still open. Otherwise the
    // `tool_execution_end` handler will have already emitted it.
    if (state.openToolCalls.has(msg.toolCallId)) {
        state.openToolCalls.delete(msg.toolCallId);
        return [
            {
                kind: 'tool_result',
                toolUseId: msg.toolCallId,
                output: msg.content,
                isError: msg.isError,
                runId,
            },
        ];
    }
    return [];
}

function mapToolExecutionStart(
    ev: Extract<AgentEvent, { type: 'tool_execution_start' }>,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    state.openToolCalls.set(ev.toolCallId, ev.toolName);
    return [
        {
            kind: 'tool_call',
            toolUseId: ev.toolCallId,
            name: ev.toolName,
            input: ev.args ?? {},
            runId,
        },
    ];
}

function mapToolExecutionEnd(
    ev: Extract<AgentEvent, { type: 'tool_execution_end' }>,
    runId: string,
    state: TranslatorState,
): HarnessEvent[] {
    if (!state.openToolCalls.has(ev.toolCallId)) {
        // Defensive: late-arriving end with no matching start. Still
        // emit the result so consumers see the pair.
        return [
            {
                kind: 'tool_result',
                toolUseId: ev.toolCallId,
                output: ev.result,
                isError: ev.isError,
                runId,
            },
        ];
    }
    state.openToolCalls.delete(ev.toolCallId);
    return [
        {
            kind: 'tool_result',
            toolUseId: ev.toolCallId,
            output: ev.result,
            isError: ev.isError,
            runId,
        },
    ];
}

/** Type guards — `AgentMessage` is pi-ai `Message` + declaration-merged
 *  custom messages, so `role` checks alone aren't structurally enough.
 *  We probe the discriminator and a key field. */
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
    const mm = m as { role?: string; content?: unknown; usage?: unknown };
    return (
        mm.role === 'assistant' &&
        Array.isArray(mm.content) &&
        typeof mm.usage === 'object' &&
        mm.usage !== null
    );
}

function isToolResultMessage(m: AgentMessage): m is ToolResultMessage {
    const mm = m as { role?: string; toolCallId?: unknown };
    return mm.role === 'toolResult' && typeof mm.toolCallId === 'string';
}
