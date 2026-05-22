/**
 * Cursor SDKMessage → HarnessEvent translator unit tests.
 *
 * Inline fixtures matching the shape declared in
 * `@cursor/sdk/dist/esm/messages.d.ts`. Each row exercises the
 * translator's per-stream state directly via `mapCursorMessage`.
 */

import { describe, expect, it } from 'vitest';
import type { SDKMessage as CursorSDKMessage } from '@cursor/sdk';
import type { HarnessEvent } from '../../types';
import {
    createTranslatorState,
    mapCursorMessage,
    mapCursorDelta,
    mapCursorRunStatus,
} from '../events';

const RUN_ID = 'run-test';

function runAll(messages: unknown[]): HarnessEvent[] {
    const state = createTranslatorState();
    const out: HarnessEvent[] = [];
    for (const m of messages) {
        for (const ev of mapCursorMessage(m as CursorSDKMessage, RUN_ID, state)) {
            out.push(ev);
        }
    }
    return out;
}

describe('mapCursorMessage', () => {
    it('system init emits status:running exactly once', () => {
        const events = runAll([
            {
                type: 'system',
                subtype: 'init',
                agent_id: 'a1',
                run_id: 'r1',
            },
            {
                type: 'system',
                subtype: 'init',
                agent_id: 'a1',
                run_id: 'r1',
            },
        ]);
        expect(events).toHaveLength(1);
        expect(events[0]).toEqual({ kind: 'status', status: 'running', runId: RUN_ID });
    });

    it('assistant message with text content emits assistant_message', () => {
        const events = runAll([
            {
                type: 'assistant',
                agent_id: 'a1',
                run_id: 'r1',
                message: {
                    role: 'assistant',
                    content: [{ type: 'text', text: 'hello there' }],
                },
            },
        ]);
        expect(events).toHaveLength(1);
        const e = events[0]!;
        expect(e.kind).toBe('assistant_message');
        if (e.kind === 'assistant_message') {
            expect(e.content).toEqual([{ type: 'text', text: 'hello there' }]);
        }
    });

    it('assistant message with tool_use block carries through to assistant_message content', () => {
        const events = runAll([
            {
                type: 'assistant',
                agent_id: 'a1',
                run_id: 'r1',
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'calling ls' },
                        { type: 'tool_use', id: 'tu1', name: 'ls', input: { path: '.' } },
                    ],
                },
            },
        ]);
        expect(events).toHaveLength(1);
        const e = events[0]!;
        if (e.kind !== 'assistant_message') throw new Error('expected assistant_message');
        expect(e.content).toEqual([
            { type: 'text', text: 'calling ls' },
            { type: 'tool_use', id: 'tu1', name: 'ls', input: { path: '.' } },
        ]);
    });

    it('tool_call running → completed emits paired tool_call + tool_result', () => {
        const events = runAll([
            {
                type: 'tool_call',
                agent_id: 'a',
                run_id: 'r',
                call_id: 'c1',
                name: 'shell',
                status: 'running',
                args: { command: 'ls' },
            },
            {
                type: 'tool_call',
                agent_id: 'a',
                run_id: 'r',
                call_id: 'c1',
                name: 'shell',
                status: 'completed',
                args: { command: 'ls' },
                result: { stdout: 'a\nb' },
            },
        ]);
        expect(events.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
        const call = events[0]!;
        const result = events[1]!;
        if (call.kind !== 'tool_call') throw new Error('expected tool_call');
        if (result.kind !== 'tool_result') throw new Error('expected tool_result');
        expect(call.toolUseId).toBe('c1');
        expect(call.name).toBe('shell');
        expect(call.input).toEqual({ command: 'ls' });
        expect(result.toolUseId).toBe('c1');
        expect(result.output).toEqual({ stdout: 'a\nb' });
        expect(result.isError).toBe(false);
    });

    it('tool_call going straight to completed (no running) still emits both events', () => {
        const events = runAll([
            {
                type: 'tool_call',
                agent_id: 'a',
                run_id: 'r',
                call_id: 'c2',
                name: 'read',
                status: 'completed',
                args: { path: 'x' },
                result: 'ok',
            },
        ]);
        expect(events.map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
    });

    it('tool_call error marks tool_result.isError', () => {
        const events = runAll([
            {
                type: 'tool_call',
                agent_id: 'a',
                run_id: 'r',
                call_id: 'c3',
                name: 'shell',
                status: 'running',
                args: {},
            },
            {
                type: 'tool_call',
                agent_id: 'a',
                run_id: 'r',
                call_id: 'c3',
                name: 'shell',
                status: 'error',
                result: 'boom',
            },
        ]);
        const last = events[events.length - 1]!;
        if (last.kind !== 'tool_result') throw new Error('expected tool_result');
        expect(last.isError).toBe(true);
        expect(last.output).toBe('boom');
    });

    it('thinking emits canonical thinking event', () => {
        const events = runAll([
            {
                type: 'thinking',
                agent_id: 'a',
                run_id: 'r',
                text: 'considering',
                thinking_duration_ms: 12,
            },
        ]);
        expect(events).toEqual([
            { kind: 'thinking', text: 'considering', runId: RUN_ID },
        ]);
    });

    it('status FINISHED emits status:completed', () => {
        const events = runAll([
            { type: 'status', agent_id: 'a', run_id: 'r', status: 'FINISHED' },
        ]);
        expect(events).toEqual([
            { kind: 'status', status: 'completed', runId: RUN_ID },
        ]);
    });

    it('status ERROR with message emits error + status:errored', () => {
        const events = runAll([
            {
                type: 'status',
                agent_id: 'a',
                run_id: 'r',
                status: 'ERROR',
                message: 'something went wrong',
            },
        ]);
        expect(events).toEqual([
            { kind: 'error', message: 'something went wrong', recoverable: false, runId: RUN_ID },
            { kind: 'status', status: 'errored', runId: RUN_ID },
        ]);
    });

    it('status RUNNING is suppressed on the stream (init already emitted leader)', () => {
        const events = runAll([
            { type: 'status', agent_id: 'a', run_id: 'r', status: 'RUNNING' },
        ]);
        expect(events).toEqual([]);
    });

    it('task start → completed emits subagent_started + subagent_completed', () => {
        const events = runAll([
            {
                type: 'task',
                agent_id: 'p',
                run_id: 'r1',
                status: 'starting',
                text: 'reviewer',
            },
            {
                type: 'task',
                agent_id: 'p',
                run_id: 'r1',
                status: 'completed',
                text: 'reviewer',
            },
        ]);
        expect(events.map((e) => e.kind)).toEqual([
            'subagent_started',
            'subagent_completed',
        ]);
        const start = events[0]!;
        if (start.kind !== 'subagent_started') throw new Error('expected start');
        expect(start.slug).toBe('reviewer');
    });

    it('user event is dropped (no canonical equivalent inside the stream)', () => {
        const events = runAll([
            {
                type: 'user',
                agent_id: 'a',
                run_id: 'r',
                message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            },
        ]);
        expect(events).toEqual([]);
    });
});

describe('mapCursorDelta', () => {
    it('textDelta update becomes assistant_delta', () => {
        const ev = mapCursorDelta(
            { type: 'textDelta', text: 'partial' } as never,
            RUN_ID,
        );
        expect(ev).toEqual({ kind: 'assistant_delta', text: 'partial', runId: RUN_ID });
    });

    it('non-text deltas are dropped', () => {
        const ev = mapCursorDelta(
            { type: 'thinkingDelta', text: 'pondering' } as never,
            RUN_ID,
        );
        expect(ev).toBeNull();
    });
});

describe('mapCursorRunStatus', () => {
    it('maps the terminal vocabulary correctly', () => {
        expect(mapCursorRunStatus('finished')).toBe('completed');
        expect(mapCursorRunStatus('error')).toBe('errored');
        expect(mapCursorRunStatus('cancelled')).toBe('canceled');
        expect(mapCursorRunStatus('running')).toBe('running');
    });
    it('CAPS variants from SDKStatusMessage map identically', () => {
        expect(mapCursorRunStatus('FINISHED')).toBe('completed');
        expect(mapCursorRunStatus('ERROR')).toBe('errored');
        expect(mapCursorRunStatus('CANCELLED')).toBe('canceled');
        expect(mapCursorRunStatus('EXPIRED')).toBe('errored');
    });
});
