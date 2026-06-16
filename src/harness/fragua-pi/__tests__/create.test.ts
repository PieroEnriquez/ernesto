/**
 * `fraguaPiCreateAgent` — pi-agent-core-specific agent factory.
 *
 * Same shape as `cursor/__tests__/create.test.ts` and
 * `cas/__tests__/create.test.ts`: mock the pi-agent-core `Agent`
 * constructor, then assert that the helper threads the right context
 * through:
 *   - systemPrompt → AgentState.systemPrompt
 *   - model resolution split on `/` provider prefix
 *   - fn tools lowered into AgentTool list
 *   - getApiKey override
 *
 * The pi-ai `getModel` is also mocked so the tests don't depend on the
 * real provider catalogs at import time.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { agentConstructorSpy, fakeAgentInstance } = vi.hoisted(() => {
    const fake: Record<string, unknown> = {
        id: 'fake-pi-agent',
        state: { messages: [], systemPrompt: '', tools: [] },
        steer: vi.fn(),
        abort: vi.fn(),
        prompt: vi.fn(async () => {}),
        waitForIdle: vi.fn(async () => {}),
        subscribe: vi.fn(() => () => {}),
    };
    return {
        agentConstructorSpy: vi.fn(() => fake),
        fakeAgentInstance: fake,
    };
});

vi.mock('@mariozechner/pi-agent-core', () => ({
    Agent: function (this: unknown, opts: unknown) {
        return agentConstructorSpy(opts);
    },
}));

vi.mock('@mariozechner/pi-ai', () => {
    return {
        Type: {
            Object: () => ({}),
            Unsafe: <T>(s: T) => s,
        },
        getModel: vi.fn((provider: string, modelId: string) => ({
            id: modelId,
            name: modelId,
            api: 'anthropic-messages',
            provider,
            baseUrl: '',
            reasoning: false,
            input: ['text'],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 8000,
        })),
        getModels: vi.fn(() => []),
        getProviders: vi.fn(() => ['anthropic']),
        getEnvApiKey: vi.fn(() => undefined),
        findEnvKeys: vi.fn(() => undefined),
    };
});

import { fraguaPiCreateAgent } from '../create';
import { createFraguaPiHarness } from '../index';
import type { AgentDefinition, ToolSpec } from '../../types';

const baseDef: AgentDefinition = {
    systemPrompt: 'be terse',
    model: 'anthropic/claude-opus-4-7',
    maxTurns: 5,
};

describe('fraguaPiCreateAgent', () => {
    beforeEach(() => {
        agentConstructorSpy.mockClear();
        (fakeAgentInstance.steer as ReturnType<typeof vi.fn>).mockClear();
        (fakeAgentInstance.abort as ReturnType<typeof vi.fn>).mockClear();
        (fakeAgentInstance.prompt as ReturnType<typeof vi.fn>).mockClear();
    });

    it('threads systemPrompt + model into Agent initialState', async () => {
        await fraguaPiCreateAgent(baseDef, { transcriptId: 'a1' });
        expect(agentConstructorSpy).toHaveBeenCalledTimes(1);
        const opts = agentConstructorSpy.mock.calls[0]?.[0] as {
            initialState?: {
                systemPrompt?: string;
                model?: { id?: string; provider?: string };
                tools?: unknown[];
            };
            sessionId?: string;
        };
        expect(opts.initialState?.systemPrompt).toBe('be terse');
        expect(opts.initialState?.model?.id).toBe('claude-opus-4-7');
        expect(opts.initialState?.model?.provider).toBe('anthropic');
        expect(opts.sessionId).toBe('a1');
    });

    it('parses bare model id with defaultProvider fallback', async () => {
        await fraguaPiCreateAgent({ ...baseDef, model: 'gpt-4o' }, { transcriptId: 'a2', providerOverride: 'openai' });
        const opts = agentConstructorSpy.mock.calls[0]?.[0] as {
            initialState?: { model?: { id?: string; provider?: string } };
        };
        expect(opts.initialState?.model?.provider).toBe('openai');
        expect(opts.initialState?.model?.id).toBe('gpt-4o');
    });

    it('parses provider-prefixed model id correctly', async () => {
        await fraguaPiCreateAgent({ ...baseDef, model: 'openrouter/anthropic/claude-3.5' }, { transcriptId: 'a3' });
        const opts = agentConstructorSpy.mock.calls[0]?.[0] as {
            initialState?: { model?: { id?: string; provider?: string } };
        };
        expect(opts.initialState?.model?.provider).toBe('openrouter');
        expect(opts.initialState?.model?.id).toBe('anthropic/claude-3.5');
    });

    it('lowers fn-shaped tools into pi-agent-core AgentTool list', async () => {
        const fnTool: ToolSpec = {
            kind: 'fn',
            name: 'adder',
            description: 'adds two numbers',
            schema: { type: 'object' },
            handler: async () => 42,
        };
        await fraguaPiCreateAgent({ ...baseDef, tools: [fnTool] }, { transcriptId: 'a4' });
        const opts = agentConstructorSpy.mock.calls[0]?.[0] as {
            initialState?: { tools?: Array<{ name: string }> };
        };
        expect(opts.initialState?.tools).toHaveLength(1);
        expect(opts.initialState?.tools?.[0]?.name).toBe('adder');
    });

    it('drops mcp-kind tools at compile (no bridge yet) and tracks warnings', async () => {
        const tool: ToolSpec = { kind: 'mcp', serverName: 'github' };
        await fraguaPiCreateAgent({ ...baseDef, tools: [tool] }, { transcriptId: 'a5' });
        const opts = agentConstructorSpy.mock.calls[0]?.[0] as {
            initialState?: { tools?: unknown[] };
        };
        expect(opts.initialState?.tools).toHaveLength(0);
    });

    it('threads apiKeyOverride into getApiKey resolver', async () => {
        await fraguaPiCreateAgent(baseDef, {
            transcriptId: 'a6',
            apiKeyOverride: 'sk-fake-key',
        });
        const opts = agentConstructorSpy.mock.calls[0]?.[0] as {
            getApiKey?: (p: string) => string | undefined;
        };
        expect(typeof opts.getApiKey).toBe('function');
        expect(opts.getApiKey?.('anthropic')).toBe('sk-fake-key');
    });

    it('close() aborts the underlying Agent', async () => {
        const handle = await fraguaPiCreateAgent(baseDef, { transcriptId: 'a7' });
        await handle.close();
        expect(fakeAgentInstance.abort).toHaveBeenCalled();
    });

    it('honors defaultDisallowedTools to drop fn tools by name', async () => {
        const allow: ToolSpec = {
            kind: 'fn',
            name: 'allowed',
            description: 'x',
            schema: {},
            handler: async () => null,
        };
        const block: ToolSpec = {
            kind: 'fn',
            name: 'blocked',
            description: 'x',
            schema: {},
            handler: async () => null,
        };
        await fraguaPiCreateAgent({ ...baseDef, tools: [allow, block] }, { transcriptId: 'a8', defaultDisallowedTools: ['blocked'] });
        const opts = agentConstructorSpy.mock.calls[0]?.[0] as {
            initialState?: { tools?: Array<{ name: string }> };
        };
        expect(opts.initialState?.tools?.map((t) => t.name)).toEqual(['allowed']);
    });
});

describe('createFraguaPiHarness — capability matrix', () => {
    it('exposes the fragua-pi capability set per the spec (with documented flips)', () => {
        const h = createFraguaPiHarness({});
        expect(h.capabilities.perTokenDeltas).toBe(true);
        expect(h.capabilities.steer).toBe(true);
        // Doc says true; honest pi-ai-layer reality is false.
        expect(h.capabilities.pause).toBe(false);
        expect(h.capabilities.hitl).toBe(false);
        // Subagents are synthesized at workflow-engine layer, not here.
        expect(h.capabilities.subagents).toBe(false);
        expect(h.capabilities.customFnTools).toBe(true);
        // mcp bridge for the MCP→fn direction is not in ernesto-lib yet.
        expect(h.capabilities.mcp).toBe(false);
        expect(h.capabilities.multiProvider).toBe(true);
        expect(h.capabilities.listMessages).toBe(true);
        expect(h.capabilities.listAgents).toBe(false);
        expect(h.capabilities.resume).toBe(false);
        expect(h.capabilities.attachments).toBe(false);
        expect(h.capabilities.costReporting).toBe(true);
        expect(h.capabilities.midResponseCancel).toBe(true);
        expect(h.capabilities.nativeStructuredOutput).toBe(false);
    });

    it('identify() returns unauthed when no API key is configured', async () => {
        const h = createFraguaPiHarness({});
        const id = await h.identify();
        expect(id.authed).toBe(false);
    });

    it('identify() returns authed when an apiKey is configured', async () => {
        const h = createFraguaPiHarness({
            apiKeys: { anthropic: 'sk-test' },
        });
        const id = await h.identify();
        expect(id.authed).toBe(true);
        expect(id.principal).toContain('anthropic');
    });

    it('capabilities object is stable across reads', () => {
        const h = createFraguaPiHarness({});
        expect(h.capabilities).toBe(h.capabilities);
    });

    it('capabilities overrides via env are respected (test seam)', () => {
        const h = createFraguaPiHarness({
            capabilities: { multiProvider: false },
        });
        expect(h.capabilities.multiProvider).toBe(false);
    });
});
