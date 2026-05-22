/**
 * `cursorCreateAgent` — Cursor-specific agent factory.
 *
 * Same shape as `cas/__tests__/create.test.ts`: mock the Cursor SDK's
 * `Agent.create` so the tests stay hermetic, then assert that the
 * helper threads the right context through:
 *   - cwd → `AgentOptions.local.cwd`
 *   - mcpServers (native) → `AgentOptions.mcpServers`
 *   - apiKey → `AgentOptions.apiKey`
 *   - synth MCP servers (fn tool wrap) merged into `mcpServers`
 *   - capabilities are exposed on the harness
 *
 * No `providerEnv` test (the Cursor harness has no provider env —
 * Cursor models are server-resolved), no `hooks` test (Cursor has no
 * hook surface).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { createSpy, sdkAgentSpy } = vi.hoisted(() => ({
    createSpy: vi.fn(),
    sdkAgentSpy: {
        agentId: 'fake-agent',
        send: vi.fn(),
        close: vi.fn(),
        reload: vi.fn(async () => {}),
        listArtifacts: vi.fn(async () => []),
        downloadArtifact: vi.fn(),
        [Symbol.asyncDispose]: async () => {},
        model: undefined,
    },
}));

vi.mock('@cursor/sdk', () => ({
    Agent: {
        create: (...args: unknown[]) => {
            createSpy(...args);
            return Promise.resolve(sdkAgentSpy);
        },
        messages: {
            list: vi.fn(async () => []),
        },
    },
    Cursor: {
        me: vi.fn(async () => ({ apiKeyName: 'k', userEmail: 'u@example.com', createdAt: '' })),
        models: { list: vi.fn(async () => []) },
    },
}));

import { cursorCreateAgent } from '../create';
import { createCursorHarness } from '../index';
import type { AgentDefinition, ToolSpec } from '../../types';

const baseDef: AgentDefinition = {
    systemPrompt: 'be terse',
    model: 'composer-latest',
    maxTurns: 5,
};

describe('cursorCreateAgent', () => {
    beforeEach(() => {
        createSpy.mockReset();
        sdkAgentSpy.send.mockReset();
        sdkAgentSpy.close.mockReset();
    });

    it('threads cwd into AgentOptions.local.cwd', async () => {
        await cursorCreateAgent(baseDef, {
            agentId: 'a1',
            cwd: '/tmp/ws',
        });
        expect(createSpy).toHaveBeenCalledTimes(1);
        const opts = createSpy.mock.calls[0][0];
        expect(opts.local?.cwd).toBe('/tmp/ws');
        expect(opts.agentId).toBe('a1');
        // settingSources default = [] (isolation).
        expect(opts.local?.settingSources).toEqual([]);
    });

    it('threads native mcpServers + apiKey through to AgentOptions', async () => {
        const mcpServers = {
            remote: { type: 'http' as const, url: 'https://example/mcp' },
        };
        await cursorCreateAgent(baseDef, {
            agentId: 'a2',
            mcpServers,
            apiKey: 'sk-test',
        });
        const opts = createSpy.mock.calls[0][0];
        expect(opts.mcpServers.remote).toEqual({
            type: 'http',
            url: 'https://example/mcp',
        });
        expect(opts.apiKey).toBe('sk-test');
    });

    it('synthesizes fn-shaped tools into the mcpServers record', async () => {
        const fnTool: ToolSpec = {
            kind: 'fn',
            name: 'adder',
            description: 'adds',
            schema: {},
            handler: async () => 0,
        };
        const def: AgentDefinition = { ...baseDef, tools: [fnTool] };
        const handle = await cursorCreateAgent(def, { agentId: 'a3' });
        const opts = createSpy.mock.calls[0][0];
        const synthEntries = Object.entries(opts.mcpServers ?? {}).filter(
            ([name]) => name.startsWith('synth_'),
        );
        expect(synthEntries).toHaveLength(1);
        const [, cfg] = synthEntries[0]!;
        expect((cfg as { type: string }).type).toBe('http');
        // Clean up the synth servers.
        await handle.close();
    });

    it('compiles SDKAgent exactly once across multiple sends', async () => {
        sdkAgentSpy.send.mockReturnValue(Promise.resolve({
            id: 'run',
            agentId: 'a',
            supports: () => true,
            unsupportedReason: () => undefined,
            stream: async function* () { /* empty */ },
            conversation: async () => [],
            wait: async () => ({ id: 'run', status: 'finished' as const }),
            cancel: async () => {},
            status: 'finished' as const,
            onDidChangeStatus: () => () => {},
        }));
        const handle = await cursorCreateAgent(baseDef, { agentId: 'a4' });
        await (await handle.send('t1')).wait();
        await (await handle.send('t2')).wait();
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(sdkAgentSpy.send).toHaveBeenCalledTimes(2);
        await handle.close();
    });

    it('close() tears down the SDKAgent', async () => {
        const handle = await cursorCreateAgent(baseDef, { agentId: 'a5' });
        await handle.close();
        expect(sdkAgentSpy.close).toHaveBeenCalledTimes(1);
    });
});

describe('createCursorHarness — capability matrix', () => {
    it('exposes the Cursor capability matrix per the spec', () => {
        const h = createCursorHarness({});
        expect(h.capabilities.perTokenDeltas).toBe(true);
        expect(h.capabilities.steer).toBe(false);
        expect(h.capabilities.pause).toBe(false);
        expect(h.capabilities.hitl).toBe(false);
        expect(h.capabilities.subagents).toBe(true);
        // The bridge synthesis layer makes this `true` at the canonical
        // surface even though Cursor's SDK only ingests MCP servers.
        expect(h.capabilities.customFnTools).toBe(true);
        expect(h.capabilities.mcp).toBe(true);
        expect(h.capabilities.multiProvider).toBe(false);
        expect(h.capabilities.listMessages).toBe(true);
        expect(h.capabilities.listAgents).toBe(true);
        expect(h.capabilities.resume).toBe(true);
        expect(h.capabilities.attachments).toBe(true);
        expect(h.capabilities.costReporting).toBe(false);
        expect(h.capabilities.midResponseCancel).toBe(false);
        expect(h.capabilities.nativeStructuredOutput).toBe(true);
    });

    it('identify() returns unauthed when no API key is configured', async () => {
        const prior = process.env.CURSOR_API_KEY;
        delete process.env.CURSOR_API_KEY;
        try {
            const h = createCursorHarness({});
            const id = await h.identify();
            expect(id.authed).toBe(false);
        } finally {
            if (prior) process.env.CURSOR_API_KEY = prior;
        }
    });
});
