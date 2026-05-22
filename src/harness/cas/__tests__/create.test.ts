/**
 * `casCreateAgent` — CAS-specific agent factory.
 *
 * Verifies the gap-2 closure: create-then-send threads CAS-private
 * context (`providerEnv`, `hooks`, `mcpServers`) through to the SDK
 * `Options` exactly once per agent, and `agent.send(prompt)` produces a
 * canonical `RunHandle` backed by `casQuery`. The underlying SDK
 * `query()` is mocked so the test stays hermetic (no network, no CLI).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Hoisted spy so we can capture the SDK options each `query()` call
// receives — that's where we assert provider env + hooks landed.
const { querySpy } = vi.hoisted(() => ({
    querySpy: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
    query: (...args: unknown[]) => querySpy(...args),
}));

// Import AFTER the SDK mock so the lazy peer-dep resolution picks the
// mock. The casCreateAgent helper itself is plain TS; only `casQuery`
// inside `send.ts` triggers SDK resolution.
import { casCreateAgent } from '../create';
import type { AgentDefinition } from '../../types';

function makeAsyncIterable(messages: unknown[]): AsyncIterable<unknown> & { interrupt: () => Promise<void> } {
    return {
        async interrupt() {},
        [Symbol.asyncIterator]() {
            let i = 0;
            return {
                async next() {
                    if (i < messages.length) return { value: messages[i++], done: false };
                    return { value: undefined, done: true };
                },
            };
        },
    };
}

const baseDef: AgentDefinition = {
    systemPrompt: 'be terse',
    model: 'claude-haiku-4-5',
    maxTurns: 5,
};

describe('casCreateAgent (gap-2)', () => {
    beforeEach(() => {
        querySpy.mockReset();
    });

    it('threads providerEnv into the SDK Options.env', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([
            { type: 'result', subtype: 'success', result: 'ok' },
        ]));

        const agent = await casCreateAgent(baseDef, {
            agentId: 'a1',
            providerEnv: {
                ANTHROPIC_API_KEY: 'sk-test',
                ANTHROPIC_BASE_URL: 'https://api.test',
            },
        });

        const run = await agent.send('hello');
        await run.wait();

        expect(querySpy).toHaveBeenCalledTimes(1);
        const call = querySpy.mock.calls[0][0] as {
            prompt: string;
            options: { env?: Record<string, string> };
        };
        expect(call.prompt).toBe('hello');
        expect(call.options.env?.ANTHROPIC_API_KEY).toBe('sk-test');
        expect(call.options.env?.ANTHROPIC_BASE_URL).toBe('https://api.test');
    });

    it('threads sandbox hooks through to SDK Options.hooks', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([
            { type: 'result', subtype: 'success', result: 'ok' },
        ]));

        const fakeHook = { PreToolUse: [{ hooks: [() => undefined] }] };
        const agent = await casCreateAgent(baseDef, {
            agentId: 'a2',
            hooks: fakeHook,
        });
        const run = await agent.send('hello');
        await run.wait();

        const call = querySpy.mock.calls[0][0] as {
            options: { hooks?: unknown };
        };
        expect(call.options.hooks).toBe(fakeHook);
    });

    it('threads mcpServers + cwd + abortController into SDK Options', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([
            { type: 'result', subtype: 'success', result: 'ok' },
        ]));

        const mcpServers = { ernesto: { type: 'sdk' as const, name: 'e', instance: {} as any } };
        const abortController = new AbortController();
        const agent = await casCreateAgent(baseDef, {
            agentId: 'a3',
            cwd: '/tmp/ws',
            abortController,
            mcpServers: mcpServers as any,
        });
        const run = await agent.send('hi');
        await run.wait();

        const call = querySpy.mock.calls[0][0] as {
            options: {
                cwd?: string;
                abortController?: AbortController;
                mcpServers?: unknown;
            };
        };
        expect(call.options.cwd).toBe('/tmp/ws');
        expect(call.options.abortController).toBe(abortController);
        expect(call.options.mcpServers).toBe(mcpServers);
    });

    it('compiles SDK Options exactly once across multiple sends', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([
            { type: 'result', subtype: 'success', result: 'ok' },
        ]));

        const agent = await casCreateAgent(baseDef, {
            agentId: 'a4',
            providerEnv: { ANTHROPIC_API_KEY: 'k' },
        });

        await (await agent.send('t1')).wait();
        await (await agent.send('t2')).wait();
        await (await agent.send('t3')).wait();

        expect(querySpy).toHaveBeenCalledTimes(3);
        // Same options object reused across calls (byte-stable cache key).
        const opts1 = (querySpy.mock.calls[0][0] as { options: unknown }).options;
        const opts2 = (querySpy.mock.calls[1][0] as { options: unknown }).options;
        const opts3 = (querySpy.mock.calls[2][0] as { options: unknown }).options;
        expect(opts1).toBe(opts2);
        expect(opts2).toBe(opts3);
    });

    it('forwards onRawMessage tap per send', async () => {
        const messages: SDKMessage[] = [
            { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } } as any,
            { type: 'result', subtype: 'success', result: 'ok' } as any,
        ];
        querySpy.mockReturnValue(makeAsyncIterable(messages));

        const agent = await casCreateAgent(baseDef, { agentId: 'a5' });
        const tap = vi.fn();
        const run = await agent.send('hi', { onRawMessage: tap });
        await run.wait();

        expect(tap).toHaveBeenCalledTimes(2);
        expect(tap.mock.calls[0][0]).toEqual(messages[0]);
        expect(tap.mock.calls[1][0]).toEqual(messages[1]);
    });

    it('returns a canonical RunHandle whose wait() drains the SDK stream', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([
            { type: 'result', subtype: 'success', result: 'final-text', duration_ms: 42 },
        ]));

        const agent = await casCreateAgent(baseDef, { agentId: 'a6' });
        const run = await agent.send('hi');
        const result = await run.wait();

        expect(result.status).toBe('completed');
        expect(result.rawText).toBe('final-text');
        expect(result.durationMs).toBe(42);
    });

    it('overrides abortController per send without re-compiling options', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([
            { type: 'result', subtype: 'success', result: 'ok' },
        ]));

        const baseAbort = new AbortController();
        const agent = await casCreateAgent(baseDef, {
            agentId: 'a7',
            abortController: baseAbort,
        });
        const perCallAbort = new AbortController();
        await (await agent.send('hi', { abortController: perCallAbort })).wait();

        const call = querySpy.mock.calls[0][0] as {
            options: { abortController?: AbortController };
        };
        expect(call.options.abortController).toBe(perCallAbort);
    });
});
