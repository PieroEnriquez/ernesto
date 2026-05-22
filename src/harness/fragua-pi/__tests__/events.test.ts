/**
 * pi-agent-core AgentEvent → HarnessEvent translator unit tests.
 *
 * Inline fixtures matching the shape declared in
 * `@mariozechner/pi-agent-core/dist/types.d.ts`. Each row exercises the
 * translator's per-stream state directly via `mapPiAgentEvent`.
 *
 * Reference: see `cursor/__tests__/events.test.ts` for the analogous
 * structure on the Cursor side.
 */

import { describe, expect, it } from 'vitest';
import type {
    AgentEvent as PiAgentEvent,
} from '@mariozechner/pi-agent-core';
import type { AssistantMessage, Usage } from '@mariozechner/pi-ai';
import type { HarnessEvent } from '../../types';
import {
    createTranslatorState,
    mapPiAgentEvent,
    mapStopReason,
} from '../events';

const RUN_ID = 'run-test';

function runAll(events: PiAgentEvent[]): HarnessEvent[] {
    const state = createTranslatorState();
    const out: HarnessEvent[] = [];
    for (const ev of events) {
        for (const e of mapPiAgentEvent(ev, RUN_ID, state)) {
            out.push(e);
        }
    }
    return out;
}

function fakeUsage(): Usage {
    return {
        input: 10,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: {
            input: 0.001,
            output: 0.002,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.003,
        },
    };
}

function fakeAssistantMessage(
    content: AssistantMessage['content'],
    extras: Partial<AssistantMessage> = {},
): AssistantMessage {
    return {
        role: 'assistant',
        content,
        api: 'anthropic-messages',
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        usage: fakeUsage(),
        stopReason: 'stop',
        timestamp: Date.now(),
        ...extras,
    };
}

describe('mapPiAgentEvent', () => {
    it('agent_start emits status:running exactly once', () => {
        const events = runAll([
            { type: 'agent_start' } as PiAgentEvent,
            { type: 'agent_start' } as PiAgentEvent,
        ]);
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({
            kind: 'status',
            status: 'running',
            runId: RUN_ID,
        });
    });

    it('turn_start / turn_end emit no canonical events', () => {
        const events = runAll([
            { type: 'turn_start' } as PiAgentEvent,
            { type: 'turn_end', message: fakeAssistantMessage([]), toolResults: [] } as PiAgentEvent,
        ]);
        expect(events).toEqual([]);
    });

    it('message_update text_delta emits assistant_delta', () => {
        const partial = fakeAssistantMessage([{ type: 'text', text: 'he' }]);
        const events = runAll([
            {
                type: 'message_update',
                message: partial,
                assistantMessageEvent: {
                    type: 'text_delta',
                    contentIndex: 0,
                    delta: 'llo',
                    partial,
                },
            } as PiAgentEvent,
        ]);
        expect(events).toEqual([
            { kind: 'assistant_delta', text: 'llo', runId: RUN_ID },
        ]);
    });

    it('message_update thinking_delta is dropped (no canonical per-token thinking)', () => {
        const partial = fakeAssistantMessage([
            { type: 'thinking', thinking: 'half-' },
        ]);
        const events = runAll([
            {
                type: 'message_update',
                message: partial,
                assistantMessageEvent: {
                    type: 'thinking_delta',
                    contentIndex: 0,
                    delta: 'baked',
                    partial,
                },
            } as PiAgentEvent,
        ]);
        expect(events).toEqual([]);
    });

    it('message_end with assistant text emits assistant_message + usage', () => {
        const msg = fakeAssistantMessage([
            { type: 'text', text: 'hello there' },
        ]);
        const events = runAll([
            { type: 'message_end', message: msg } as PiAgentEvent,
        ]);
        expect(events).toHaveLength(2);
        expect(events[0]).toEqual({
            kind: 'assistant_message',
            content: [{ type: 'text', text: 'hello there' }],
            runId: RUN_ID,
        });
        const u = events[1];
        if (u.kind !== 'usage') throw new Error('expected usage');
        expect(u.inputTokens).toBe(10);
        expect(u.outputTokens).toBe(20);
        expect(u.costUsd).toBeCloseTo(0.003);
    });

    it('message_end with thinking + text emits thinking then assistant_message', () => {
        const msg = fakeAssistantMessage([
            { type: 'thinking', thinking: 'pondering' },
            { type: 'text', text: 'answer' },
        ]);
        const events = runAll([
            { type: 'message_end', message: msg } as PiAgentEvent,
        ]);
        const kinds = events.map((e) => e.kind);
        expect(kinds).toEqual(['thinking', 'assistant_message', 'usage']);
        const thinking = events[0];
        if (thinking.kind !== 'thinking') throw new Error();
        expect(thinking.text).toBe('pondering');
    });

    it('message_end with tool_use block surfaces tool_use in assistant_message content', () => {
        const msg = fakeAssistantMessage([
            { type: 'text', text: 'using ls' },
            {
                type: 'toolCall',
                id: 'tu1',
                name: 'ls',
                arguments: { path: '.' },
            },
        ]);
        const events = runAll([
            { type: 'message_end', message: msg } as PiAgentEvent,
        ]);
        const assistant = events[0];
        if (assistant.kind !== 'assistant_message') throw new Error();
        expect(assistant.content).toEqual([
            { type: 'text', text: 'using ls' },
            { type: 'tool_use', id: 'tu1', name: 'ls', input: { path: '.' } },
        ]);
    });

    it('tool_execution_start/end emit paired tool_call + tool_result', () => {
        const events = runAll([
            {
                type: 'tool_execution_start',
                toolCallId: 'tu1',
                toolName: 'ls',
                args: { path: '.' },
            } as PiAgentEvent,
            {
                type: 'tool_execution_end',
                toolCallId: 'tu1',
                toolName: 'ls',
                result: { entries: ['a', 'b'] },
                isError: false,
            } as PiAgentEvent,
        ]);
        expect(events).toHaveLength(2);
        expect(events[0]).toEqual({
            kind: 'tool_call',
            toolUseId: 'tu1',
            name: 'ls',
            input: { path: '.' },
            runId: RUN_ID,
        });
        expect(events[1]).toEqual({
            kind: 'tool_result',
            toolUseId: 'tu1',
            output: { entries: ['a', 'b'] },
            isError: false,
            runId: RUN_ID,
        });
    });

    it('tool_execution_end marks isError when handler failed', () => {
        const events = runAll([
            {
                type: 'tool_execution_start',
                toolCallId: 'tu2',
                toolName: 'bash',
                args: {},
            } as PiAgentEvent,
            {
                type: 'tool_execution_end',
                toolCallId: 'tu2',
                toolName: 'bash',
                result: 'EACCES',
                isError: true,
            } as PiAgentEvent,
        ]);
        const tr = events[1];
        if (tr.kind !== 'tool_result') throw new Error();
        expect(tr.isError).toBe(true);
    });

    it('agent_end with stop terminal emits status:completed', () => {
        const events = runAll([
            { type: 'agent_start' } as PiAgentEvent,
            {
                type: 'agent_end',
                messages: [
                    fakeAssistantMessage([{ type: 'text', text: 'ok' }], {
                        stopReason: 'stop',
                    }),
                ],
            } as PiAgentEvent,
        ]);
        const final = events[events.length - 1];
        expect(final).toEqual({
            kind: 'status',
            status: 'completed',
            runId: RUN_ID,
        });
    });

    it('agent_end with error terminal emits error + status:errored', () => {
        const events = runAll([
            { type: 'agent_start' } as PiAgentEvent,
            {
                type: 'agent_end',
                messages: [
                    fakeAssistantMessage([], {
                        stopReason: 'error',
                        errorMessage: '402 payment required',
                    }),
                ],
            } as PiAgentEvent,
        ]);
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain('error');
        expect(kinds[kinds.length - 1]).toBe('status');
        const final = events[events.length - 1];
        if (final.kind !== 'status') throw new Error();
        expect(final.status).toBe('errored');
    });

    it('agent_end with aborted terminal emits status:canceled', () => {
        const events = runAll([
            { type: 'agent_start' } as PiAgentEvent,
            {
                type: 'agent_end',
                messages: [
                    fakeAssistantMessage([], {
                        stopReason: 'aborted',
                    }),
                ],
            } as PiAgentEvent,
        ]);
        const final = events[events.length - 1];
        if (final.kind !== 'status') throw new Error();
        expect(final.status).toBe('canceled');
    });
});

describe('mapStopReason', () => {
    it('stop / length / toolUse → completed', () => {
        expect(mapStopReason('stop')).toBe('completed');
        expect(mapStopReason('length')).toBe('completed');
        expect(mapStopReason('toolUse')).toBe('completed');
    });
    it('error → errored, aborted → canceled', () => {
        expect(mapStopReason('error')).toBe('errored');
        expect(mapStopReason('aborted')).toBe('canceled');
    });
    it('unknown / undefined → completed (defensive default)', () => {
        expect(mapStopReason(undefined)).toBe('completed');
        expect(mapStopReason('whatever')).toBe('completed');
    });
});
