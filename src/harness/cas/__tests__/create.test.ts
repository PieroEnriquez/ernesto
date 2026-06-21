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
import { createCasHarness } from '../index';
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
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

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
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

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
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

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
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

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
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'final-text', duration_ms: 42 }]));

        const agent = await casCreateAgent(baseDef, { agentId: 'a6' });
        const run = await agent.send('hi');
        const result = await run.wait();

        expect(result.status).toBe('completed');
        expect(result.rawText).toBe('final-text');
        expect(result.durationMs).toBe(42);
    });

    it('overrides abortController per send without re-compiling options', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

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

// ─────────────────────────────────────────────────────────────────────────
// NEGATIVE TESTS — agent built-in tool allowlist / deny-list enforcement.
//
// A "read-only" workflow step declares `tools:[Read,Glob,Grep]` (or the
// structural AgentDefinition.tools = [{kind:'builtin',name:'Read'}]). That
// allowlist MUST become the SDK Options.tools whitelist so Write/Edit/Bash
// are not reachable. These assert the restriction RESTRICTS, against the REAL
// casCreateAgent + coerceToCompiledAgent + compileAgentToSdkOptions pipeline
// (only the SDK `query()` itself is mocked — the enforcer under test is real).
// ─────────────────────────────────────────────────────────────────────────
describe('casCreateAgent tool-allowlist enforcement (negative)', () => {
    beforeEach(() => {
        querySpy.mockReset();
    });

    // boundary: agent-tools-allowlist-dropped
    // An agent step's def.tools allowlist (here passed as the SDK-shaped
    // CasCreateOptions.tools string[]) MUST reach Options.tools so the
    // forbidden tools are absent. Today casCreateAgent DOES forward
    // opts.tools (compile.ts L107), so this one is expected to HOLD — it is
    // the regression net for the one allowlist path that works.
    it('forwards the declared CasCreateOptions.tools allowlist to Options.tools (Write/Edit/Bash absent)', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

        const agent = await casCreateAgent(
            { systemPrompt: 'be terse', model: 'claude-haiku-4-5', maxTurns: 5 },
            { agentId: 'tools-1', tools: ['Read', 'Glob', 'Grep'] },
        );
        await (await agent.send('hi')).wait();

        const call = querySpy.mock.calls[0][0] as { options: { tools?: string[] } };
        expect(call.options.tools).toEqual(['Read', 'Glob', 'Grep']);
        expect(call.options.tools).not.toContain('Write');
        expect(call.options.tools).not.toContain('Edit');
        expect(call.options.tools).not.toContain('Bash');
    });

    // boundary: agent-tools-allowlist-dropped (the actual documented gap)
    // When the allowlist is declared on the AgentDefinition itself
    // (def.tools = [{kind:'builtin',name:'Read'},...]) — the way a workflow
    // step declares "read-only" — coerceToCompiledAgent drops it on BOTH
    // branches (CompiledAgent has no `tools` field), and compileAgentToSdkOptions
    // only honors ctx.tools (never set from def). So Options.tools is undefined
    // and the agent silently gets the full default tool surface incl. Write/Edit/Bash.
    it('FAIL-OPEN: agent def.tools allowlist dropped — read-only step actually has Write/Edit/Bash — unskip when fixed', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

        const agent = await casCreateAgent(
            {
                systemPrompt: 'be terse',
                model: 'claude-haiku-4-5',
                maxTurns: 5,
                tools: [
                    { kind: 'builtin', name: 'Read' },
                    { kind: 'builtin', name: 'Glob' },
                    { kind: 'builtin', name: 'Grep' },
                ],
            },
            { agentId: 'tools-2' },
        );
        await (await agent.send('hi')).wait();

        const call = querySpy.mock.calls[0][0] as { options: { tools?: string[] } };
        // The declared allowlist must reach the SDK …
        expect(call.options.tools).toEqual(['Read', 'Glob', 'Grep']);
        // … and the write-capable tools must be absent.
        expect(call.options.tools).not.toContain('Write');
        expect(call.options.tools).not.toContain('Edit');
        expect(call.options.tools).not.toContain('Bash');
    });

    // boundary: cas-tools-allowlist-dropped
    // Same gap, asserted at the "no Write/Edit/Bash reachable" level with the
    // either/or escape (allowlist forwarded OR unlisted tools denied).
    it('FAIL-OPEN: CAS drops AgentDefinition.tools allowlist — read-only step gets full Write/Edit/Bash — unskip when fixed', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

        const agent = await casCreateAgent(
            { systemPrompt: 'be terse', model: 'claude-haiku-4-5', maxTurns: 5, tools: [{ kind: 'builtin', name: 'Read' }] },
            { agentId: 'tools-3' },
        );
        await (await agent.send('hi')).wait();

        const call = querySpy.mock.calls[0][0] as {
            options: { tools?: string[]; disallowedTools?: string[] };
        };
        // The declared restriction must be honored one of two ways:
        //   (a) the allowlist is forwarded verbatim, or
        //   (b) the write-capable tools are explicitly denied.
        const allowlistForwarded = JSON.stringify(call.options.tools) === JSON.stringify(['Read']);
        const deniesWrites =
            !!call.options.disallowedTools && ['Write', 'Edit', 'Bash'].every((t) => call.options.disallowedTools!.includes(t));
        expect(allowlistForwarded || deniesWrites).toBe(true);
    });

    // boundary: cas-tools-unenforceable-fail-closed
    // Declaring a restriction the harness cannot enforce must fail CLOSED
    // (throw), not silently resolve a fully-tooled agent.
    it('FAIL-OPEN: CAS coerceToCompiledAgent silently discards an unenforceable tools restriction instead of throwing — unskip when fixed', async () => {
        // An `mcp`/`fn` tool spec is NOT expressible as the SDK's builtin
        // `Options.tools` allowlist — the engine cannot enforce it as a
        // tool-surface restriction, so it must fail CLOSED (throw) rather
        // than silently resolve a fully-tooled agent.
        await expect(
            casCreateAgent(
                {
                    systemPrompt: 'be terse',
                    model: 'claude-haiku-4-5',
                    maxTurns: 5,
                    tools: [
                        { kind: 'builtin', name: 'Read' },
                        { kind: 'mcp', serverName: 'ernesto' },
                    ],
                },
                { agentId: 'tools-4' },
            ),
        ).rejects.toThrow(/tools|unsupported|cannot enforce/i);
    });

    // boundary: cas-native-off-switch
    // `disableNativeTools` is the HARD off-switch: it must lower the SDK's
    // `Options.tools` to `[]` ("disable all built-ins"), so NO native tool
    // (Read/Write/Edit/MultiEdit/Bash/Glob/Grep/Task/WebFetch/WebSearch/…)
    // reaches the model — categorically, not by enumerating a denylist.
    // It WINS over any `tools` allowlist.
    it('disableNativeTools lowers Options.tools to [] (all native built-ins off)', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

        const agent = await casCreateAgent(
            {
                systemPrompt: 'be terse',
                model: 'claude-haiku-4-5',
                maxTurns: 5,
                disableNativeTools: true,
            },
            { agentId: 'native-off-1' },
        );
        await (await agent.send('hi')).wait();

        const call = querySpy.mock.calls[0][0] as { options: { tools?: string[] } };
        // EXACTLY the empty allowlist — present, and empty.
        expect(call.options.tools).toEqual([]);
        // Pin the dangerous natives specifically as unreachable.
        for (const banned of ['Write', 'Edit', 'MultiEdit', 'Bash', 'Read', 'Glob', 'Grep', 'Task', 'WebFetch', 'WebSearch', 'NotebookEdit', 'TodoWrite']) {
            expect(call.options.tools).not.toContain(banned);
        }
    });

    // disableNativeTools wins even when a (would-be permissive) tools
    // allowlist is also declared — the off-switch is absolute.
    it('disableNativeTools overrides a declared tools allowlist (still [])', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

        const agent = await casCreateAgent(
            {
                systemPrompt: 'be terse',
                model: 'claude-haiku-4-5',
                maxTurns: 5,
                disableNativeTools: true,
                tools: [
                    { kind: 'builtin', name: 'Read' },
                    { kind: 'builtin', name: 'Bash' },
                ],
            },
            { agentId: 'native-off-2' },
        );
        await (await agent.send('hi')).wait();

        const call = querySpy.mock.calls[0][0] as { options: { tools?: string[] } };
        expect(call.options.tools).toEqual([]);
    });

    // boundary: cas-disallowed-tools-denied (expected to HOLD)
    // The one tool restriction CAS DOES honor: an explicit disallowedTools
    // deny-list must reach Options.disallowedTools.
    it('forwards AgentDefinition.disallowedTools deny-list to Options.disallowedTools', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

        const agent = await casCreateAgent(
            { systemPrompt: 'be terse', model: 'claude-haiku-4-5', maxTurns: 5, disallowedTools: ['Bash', 'Write'] },
            { agentId: 'tools-5' },
        );
        await (await agent.send('hi')).wait();

        const call = querySpy.mock.calls[0][0] as { options: { disallowedTools?: string[] } };
        expect(call.options.disallowedTools).toContain('Bash');
        expect(call.options.disallowedTools).toContain('Write');
    });

    // boundary: cas-disallowed-tools-denied — defaultDisallowedTools fallback
    // With def.disallowedTools undefined but opts.defaultDisallowedTools set,
    // the fallback deny-list must reach the SDK surface.
    it('applies defaultDisallowedTools fallback when def.disallowedTools is unset', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

        const agent = await casCreateAgent(
            { systemPrompt: 'be terse', model: 'claude-haiku-4-5', maxTurns: 5 },
            { agentId: 'tools-6', defaultDisallowedTools: ['Bash'] },
        );
        await (await agent.send('hi')).wait();

        const call = querySpy.mock.calls[0][0] as { options: { disallowedTools?: string[] } };
        expect(call.options.disallowedTools).toContain('Bash');
    });
});

// A1 regression: the GENERIC Harness.createAgent route (what the in-process
// transport actually uses) must forward per-call options — notably the sandbox
// `hooks` — to the SDK. This route previously hand-re-listed fields and silently
// dropped `hooks`, nullifying the FS sandbox for every in-process agent turn.
// The existing suite only exercised `casCreateAgent` directly, so the gap shipped.
describe('createCasHarness.createAgent route (A1 regression)', () => {
    beforeEach(() => {
        querySpy.mockReset();
    });

    it('forwards CreateOptions.hooks through to SDK Options.hooks', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

        const fakeHook = { PreToolUse: [{ hooks: [() => undefined] }] };
        const harness = createCasHarness({});
        const agent = await harness.createAgent(baseDef, {
            agentId: 'wrap-1',
            cwd: '/tmp/wd',
            hooks: fakeHook,
        });
        const run = await agent.send('hello');
        await run.wait();

        const call = querySpy.mock.calls[0][0] as {
            options: { hooks?: unknown; cwd?: string };
        };
        // The whole point of A1: hooks reach the SDK on the generic route.
        expect(call.options.hooks).toBe(fakeHook);
        // And the rest of the spread still flows (no field re-listing regressions).
        expect(call.options.cwd).toBe('/tmp/wd');
    });

    it('a harness built with no hooks yields Options.hooks undefined (no accidental default)', async () => {
        querySpy.mockReturnValue(makeAsyncIterable([{ type: 'result', subtype: 'success', result: 'ok' }]));

        const harness = createCasHarness({});
        const agent = await harness.createAgent(baseDef, { agentId: 'wrap-2' });
        const run = await agent.send('hello');
        await run.wait();

        const call = querySpy.mock.calls[0][0] as { options: { hooks?: unknown } };
        expect(call.options.hooks).toBeUndefined();
    });
});
