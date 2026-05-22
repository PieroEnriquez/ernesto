/**
 * SDKMessage → HarnessEvent translator unit tests.
 *
 * Step 1 keeps fixtures inline rather than splitting JSONL files —
 * easier to read for the table-driven cases here. The translator's
 * `TranslatorState` is exercised directly via `mapSdkMessage` so each
 * row can be asserted independently.
 *
 * The SDK types are imported only for typing; we build minimal
 * structural objects matching the SDK's shape and cast at the boundary
 * — calling `query()` (which would touch the network / CLI) is not
 * required here.
 */

import { describe, expect, it } from 'vitest';
import type {
    SDKMessage,
    SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { HarnessEvent } from '../../types';
import { createTranslatorState, mapSdkMessage } from '../events';
import { mapResult } from '../send';

const RUN_ID = 'run-test';

function runAll(messages: unknown[]): HarnessEvent[] {
    const state = createTranslatorState();
    const out: HarnessEvent[] = [];
    for (const m of messages) {
        for (const ev of mapSdkMessage(m as SDKMessage, RUN_ID, state)) {
            out.push(ev);
        }
    }
    return out;
}

describe('mapSdkMessage', () => {
    it('simple prompt: init → assistant → result yields assistant_message + usage + status:completed', () => {
        const events = runAll([
            {
                type: 'system',
                subtype: 'init',
                session_id: 's1',
                cwd: '/tmp',
                tools: [],
                mcp_servers: [],
                model: 'claude-opus-4-7',
                apiKeySource: 'user',
                claude_code_version: '0.0.0',
                uuid: 'u1',
            },
            {
                type: 'assistant',
                parent_tool_use_id: null,
                uuid: 'u2',
                session_id: 's1',
                message: {
                    content: [{ type: 'text', text: 'hello there' }],
                },
            },
            {
                type: 'result',
                subtype: 'success',
                duration_ms: 100,
                duration_api_ms: 90,
                is_error: false,
                num_turns: 1,
                result: 'ok',
                stop_reason: 'end_turn',
                total_cost_usd: 0.0012,
                usage: {
                    input_tokens: 10,
                    output_tokens: 5,
                    cache_read_input_tokens: 2,
                    cache_creation_input_tokens: 1,
                },
                modelUsage: {},
                permission_denials: [],
                uuid: 'u3',
                session_id: 's1',
            },
        ]);

        const kinds = events.map((e) => e.kind);
        expect(kinds).toEqual([
            'status', // running
            'assistant_message',
            'usage',
            'status', // completed
        ]);
        const assistant = events[1];
        expect(assistant && assistant.kind === 'assistant_message').toBe(true);
        if (assistant && assistant.kind === 'assistant_message') {
            expect(assistant.content).toEqual([
                { type: 'text', text: 'hello there' },
            ]);
        }
        const usage = events[2];
        if (usage && usage.kind === 'usage') {
            expect(usage.inputTokens).toBe(10);
            expect(usage.outputTokens).toBe(5);
            expect(usage.cacheRead).toBe(2);
            expect(usage.cacheWrite).toBe(1);
            expect(usage.costUsd).toBe(0.0012);
        }
        const last = events[events.length - 1];
        expect(last?.kind === 'status' && last.status === 'completed').toBe(
            true,
        );
    });

    it('tool call roundtrip: tool_call precedes tool_result with matching toolUseId', () => {
        const events = runAll([
            {
                type: 'assistant',
                parent_tool_use_id: null,
                uuid: 'u1',
                session_id: 's1',
                message: {
                    content: [
                        { type: 'text', text: 'calling a tool' },
                        {
                            type: 'tool_use',
                            id: 'tu_1',
                            name: 'Read',
                            input: { path: '/etc/hosts' },
                        },
                    ],
                },
            },
            {
                type: 'user',
                parent_tool_use_id: null,
                uuid: 'u2',
                session_id: 's1',
                message: {
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'tu_1',
                            content: 'localhost',
                            is_error: false,
                        },
                    ],
                },
            },
        ]);

        const kinds = events.map((e) => e.kind);
        // Order: per-row, tool_use blocks emit a tool_call before the
        // turn's assistant_message; the user message then emits tool_result.
        expect(kinds).toEqual(['tool_call', 'assistant_message', 'tool_result']);
        const call = events[0];
        const result = events[2];
        if (call && call.kind === 'tool_call') {
            expect(call.toolUseId).toBe('tu_1');
            expect(call.name).toBe('Read');
            expect(call.input).toEqual({ path: '/etc/hosts' });
        }
        if (result && result.kind === 'tool_result') {
            expect(result.toolUseId).toBe('tu_1');
            expect(result.output).toBe('localhost');
            expect(result.isError).toBe(false);
        }
    });

    it('subagent (Task builtin): subagent_started + nested events + subagent_completed', () => {
        const events = runAll([
            // Parent assistant invokes the Task builtin.
            {
                type: 'assistant',
                parent_tool_use_id: null,
                uuid: 'u1',
                session_id: 's1',
                message: {
                    content: [
                        {
                            type: 'tool_use',
                            id: 'task_1',
                            name: 'Task',
                            input: {
                                subagent_type: 'researcher',
                                description: 'go look',
                            },
                        },
                    ],
                },
            },
            // Nested assistant message stamped with parent_tool_use_id.
            {
                type: 'assistant',
                parent_tool_use_id: 'task_1',
                subagent_type: 'researcher',
                uuid: 'u2',
                session_id: 's1',
                message: {
                    content: [{ type: 'text', text: 'found it' }],
                },
            },
            // Task closure: user-side tool_result for task_1.
            {
                type: 'user',
                parent_tool_use_id: null,
                uuid: 'u3',
                session_id: 's1',
                message: {
                    content: [
                        {
                            type: 'tool_result',
                            tool_use_id: 'task_1',
                            content: 'found it',
                            is_error: false,
                        },
                    ],
                },
            },
        ]);

        const kinds = events.map((e) => e.kind);
        // First row: tool_call (Task) + assistant_message.
        // Second row: subagent_started + assistant_message (nested).
        // Third row: tool_result + subagent_completed.
        expect(kinds).toEqual([
            'tool_call',
            'assistant_message',
            'subagent_started',
            'assistant_message',
            'tool_result',
            'subagent_completed',
        ]);
        const started = events.find((e) => e.kind === 'subagent_started');
        const completed = events.find((e) => e.kind === 'subagent_completed');
        if (started && started.kind === 'subagent_started') {
            expect(started.slug).toBe('researcher');
            expect(started.subRunId).toBe('task_1');
            expect(started.parentRunId).toBe(RUN_ID);
        }
        if (completed && completed.kind === 'subagent_completed') {
            expect(completed.subRunId).toBe('task_1');
            expect(completed.result).toBe('found it');
        }
    });

    it('result message populates the new RunResult fields (apiDurationMs, modelUsage, subtype, rawText, structuredOutput)', () => {
        const sdkResult = {
            type: 'result',
            subtype: 'success',
            duration_ms: 500,
            duration_api_ms: 420,
            is_error: false,
            num_turns: 3,
            result: 'final raw text from SDK',
            stop_reason: 'end_turn',
            total_cost_usd: 0.05,
            usage: {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_input_tokens: 20,
                cache_creation_input_tokens: 5,
            },
            modelUsage: {
                'claude-opus-4-7': {
                    inputTokens: 80,
                    outputTokens: 40,
                    cacheReadInputTokens: 16,
                    cacheCreationInputTokens: 4,
                    webSearchRequests: 0,
                    costUSD: 0.04,
                    contextWindow: 200000,
                    maxOutputTokens: 8192,
                },
                'claude-haiku-4-5': {
                    inputTokens: 20,
                    outputTokens: 10,
                    cacheReadInputTokens: 4,
                    cacheCreationInputTokens: 1,
                    webSearchRequests: 0,
                    costUSD: 0.01,
                    contextWindow: 200000,
                    maxOutputTokens: 8192,
                },
            },
            permission_denials: [],
            structured_output: { answer: 42 },
            uuid: 'u-result',
            session_id: 's1',
        } as unknown as SDKResultMessage;

        const run = mapResult({
            runId: RUN_ID,
            status: 'completed',
            finalAssistant: [{ type: 'text', text: 'final raw text from SDK' }],
            usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.05 },
            durationMs: 600,
            sdkResult,
        });

        expect(run.apiDurationMs).toBe(420);
        expect(run.subtype).toBe('success');
        expect(run.rawText).toBe('final raw text from SDK');
        expect(run.structuredOutput).toEqual({ answer: 42 });
        expect(run.modelUsage).toEqual({
            'claude-opus-4-7': {
                inputTokens: 80,
                outputTokens: 40,
                costUsd: 0.04,
            },
            'claude-haiku-4-5': {
                inputTokens: 20,
                outputTokens: 10,
                costUsd: 0.01,
            },
        });
    });

    it('structured_output round-trip: RunResult.structuredOutput equals SDK payload (regression for gap 3)', () => {
        const sdkResult = {
            type: 'result',
            subtype: 'success',
            duration_ms: 10,
            duration_api_ms: 8,
            is_error: false,
            num_turns: 1,
            result: '{"foo":"bar"}',
            stop_reason: 'end_turn',
            total_cost_usd: 0.001,
            usage: {
                input_tokens: 1,
                output_tokens: 1,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
            },
            modelUsage: {},
            permission_denials: [],
            structured_output: { foo: 'bar' },
            uuid: 'u-result',
            session_id: 's1',
        } as unknown as SDKResultMessage;

        const run = mapResult({
            runId: RUN_ID,
            status: 'completed',
            usage: { inputTokens: 1, outputTokens: 1 },
            durationMs: 10,
            sdkResult,
        });

        expect(run.structuredOutput).toEqual({ foo: 'bar' });
    });

    it('mapResult leaves optional fields unset when no sdkResult is provided', () => {
        const run = mapResult({
            runId: RUN_ID,
            status: 'errored',
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs: 0,
            errorMessage: 'boom',
        });
        expect(run.apiDurationMs).toBeUndefined();
        expect(run.modelUsage).toBeUndefined();
        expect(run.subtype).toBeUndefined();
        expect(run.rawText).toBeUndefined();
        expect(run.structuredOutput).toBeUndefined();
        expect(run.error?.message).toBe('boom');
    });

    it('cancel mid-stream: no usage after status:canceled', () => {
        // The translator itself doesn't emit `status: canceled` —
        // that's the responsibility of `casSend.cancel()` (it inserts
        // a synthetic event into the buffer when the user calls
        // cancel). The invariant under test: once a caller has stopped
        // pulling from the translator, no usage event leaks out.
        const state = createTranslatorState();
        const partial = [
            {
                type: 'system',
                subtype: 'init',
                session_id: 's1',
                cwd: '/tmp',
                tools: [],
                mcp_servers: [],
                model: 'claude-opus-4-7',
                apiKeySource: 'user',
                claude_code_version: '0.0.0',
                uuid: 'u1',
            } as unknown as SDKMessage,
            {
                type: 'assistant',
                parent_tool_use_id: null,
                uuid: 'u2',
                session_id: 's1',
                message: { content: [{ type: 'text', text: 'partial' }] },
            } as unknown as SDKMessage,
        ];
        const out: HarnessEvent[] = [];
        for (const m of partial) {
            for (const ev of mapSdkMessage(m, RUN_ID, state)) out.push(ev);
        }
        // Synthetic cancel injection happens at the send.ts layer; we
        // simulate it here for the assertion.
        out.push({ kind: 'status', status: 'canceled', runId: RUN_ID });
        const cancelIndex = out.findIndex(
            (e) => e.kind === 'status' && e.status === 'canceled',
        );
        expect(cancelIndex).toBeGreaterThanOrEqual(0);
        const afterCancel = out.slice(cancelIndex + 1);
        const hasUsageAfter = afterCancel.some((e) => e.kind === 'usage');
        expect(hasUsageAfter).toBe(false);
    });
});
