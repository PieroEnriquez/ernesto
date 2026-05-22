/**
 * fragua-pi-specific agent-creation helper.
 *
 * Same pattern as `casCreateAgent` / `cursorCreateAgent`: a strongly-
 * typed pi-aware entry point alongside the narrow
 * `Harness.createAgent(def, opts)` surface. Backend wrappers that need
 * pi-private context (provider override, API key resolver) flow
 * through this helper.
 *
 * Lifecycle:
 *
 *   1. Compile `AgentDefinition` → pi-agent-core init pieces via
 *      `compile.ts`. fn-shaped tools land directly as
 *      pi-agent-core `AgentTool`s (no MCP-bridge synthesis like
 *      Cursor — pi-ai accepts fn tools natively).
 *   2. Construct `new Agent({ initialState, getApiKey, sessionId })`.
 *   3. `handle.send(prompt)` issues `fraguaPiSend(agent, prompt)`
 *      and returns a canonical `RunHandle`.
 *   4. `handle.close()` aborts the agent's current run (if any) and
 *      clears subscribed listeners.
 */

import { randomUUID } from 'crypto';
import { Agent } from '@mariozechner/pi-agent-core';
import type {
    AgentMessage as PiAgentMessage,
    AgentEvent as PiAgentEvent,
} from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type {
    AgentDefinition,
    AgentHandle,
    HarnessMessage,
    RunHandle,
    SendOptions,
    UserMessage,
} from '../types';
import {
    compileAgentToFraguaPiOptions,
    type FraguaPiProvider,
} from './compile';
import { fraguaPiSend, type FraguaPiRunHandle } from './send';

/** Strongly-typed fragua-pi create options. Superset of the canonical
 *  `CreateOptions`. */
export interface FraguaPiCreateOptions {
    /** Stable id propagated as the harness handle's `id`. */
    sessionId?: string;
    /** Working directory bound to this agent's runs. Currently
     *  informational — pi-agent-core has no `cwd` field of its own. */
    cwd?: string;
    /** Caller-controlled abort for the entire agent lifetime. */
    abortController?: AbortController;
    /** pi-ai MCP server map (opaque per our surface — pi-ai doesn't
     *  natively ingest MCP today; this is forwarded for forwards-compat
     *  when the harness mcp-bridge lands). */
    mcpServers?: Record<string, unknown>;
    /** Env hooks (forwarded informationally; pi-agent-core resolves
     *  API keys via `getApiKey`, not via env). */
    env?: Record<string, string>;
    /** Allow-list of builtin tools (informational — pi-ai has no
     *  builtin-tool surface). */
    tools?: string[];
    /** Default disallowed-tools list applied when the declaration
     *  leaves it unset. */
    defaultDisallowedTools?: string[];
    /** Override the provider extracted from `def.model` (`anthropic/…`).
     *  Useful for routing the same model id through a different
     *  provider (e.g. `openrouter` vs direct). */
    providerOverride?: FraguaPiProvider;
    /** Override the API key resolution. Falls back to harness-env's
     *  `apiKeys` map → `getEnvApiKey` from pi-ai. */
    apiKeyOverride?: string;
    /** Direct API-key resolver (per-provider). Forwarded to
     *  pi-agent-core's `Agent.getApiKey`. Takes precedence over
     *  `apiKeyOverride`. */
    getApiKey?: (
        provider: string,
    ) => Promise<string | undefined> | string | undefined;
}

/** Per-send fragua-pi extensions on top of the canonical `SendOptions`. */
export interface FraguaPiAgentSendOptions extends SendOptions {
    /** Tap each raw pi-agent-core `AgentEvent` as it arrives. Mirrors
     *  `CasAgentSendOptions.onRawMessage`. */
    onRawMessage?: (event: PiAgentEvent) => void;
}

/** fragua-pi-typed agent handle. Structurally a canonical `AgentHandle`. */
export interface FraguaPiAgentHandle extends AgentHandle {
    send(
        msg: UserMessage,
        opts?: FraguaPiAgentSendOptions,
    ): Promise<RunHandle>;
    /** fragua-pi-only: abort any active run and tear down listeners. */
    close(): Promise<void>;
    /** Replay the in-memory transcript. pi-agent-core keeps a
     *  per-`Agent` transcript on `agent.state.messages` — we project
     *  it into canonical `HarnessMessage` shape. */
    getMessages(): Promise<HarnessMessage[]>;
}

/**
 * Create a fragua-pi-backed `AgentHandle`. The pi-agent-core `Agent`
 * is constructed exactly once; each `agent.send(prompt)` reuses the
 * same instance.
 */
export async function fraguaPiCreateAgent(
    def: AgentDefinition,
    opts: FraguaPiCreateOptions = {},
): Promise<FraguaPiAgentHandle> {
    const agentId = opts.sessionId ?? `fragua-pi-${randomUUID()}`;

    // Compile harness IR → pi-agent-core init bits.
    const compileCtx: Parameters<
        typeof compileAgentToFraguaPiOptions
    >[1] = {};
    if (opts.providerOverride !== undefined) {
        compileCtx.defaultProvider = opts.providerOverride;
    }
    if (opts.defaultDisallowedTools !== undefined) {
        compileCtx.defaultDisallowedTools = opts.defaultDisallowedTools;
    }
    if (opts.sessionId !== undefined) compileCtx.sessionId = opts.sessionId;
    // Resolve API keys per-call: explicit `getApiKey` wins, then a
    // single `apiKeyOverride` string applies to every provider, then
    // pi-ai's `getEnvApiKey` reads `<PROVIDER>_API_KEY` from the env.
    const resolver = buildApiKeyResolver(opts);
    if (resolver) compileCtx.getApiKey = resolver;

    const compiled = compileAgentToFraguaPiOptions(def, compileCtx);

    // Construct the pi-agent-core agent.
    const agentOpts: ConstructorParameters<typeof Agent>[0] = {
        initialState: {
            systemPrompt: compiled.systemPrompt,
            model: compiled.model,
            tools: compiled.tools,
        },
    };
    if (compiled.getApiKey !== undefined) {
        agentOpts.getApiKey = compiled.getApiKey;
    }
    if (compiled.sessionId !== undefined) {
        agentOpts.sessionId = compiled.sessionId;
    }
    const piAgent = new Agent(agentOpts);

    // Abort plumbing — pi-agent-core has its own `agent.abort()` for the
    // current run; we hook the caller's `abortController` to it so signal
    // abort triggers `agent.abort()` automatically.
    let aborted = false;
    if (opts.abortController) {
        const onAbort = (): void => {
            if (aborted) return;
            aborted = true;
            try {
                piAgent.abort();
            } catch {
                // best-effort
            }
        };
        if (opts.abortController.signal.aborted) {
            onAbort();
        } else {
            opts.abortController.signal.addEventListener('abort', onAbort, {
                once: true,
            });
        }
    }

    // Pre-emit any compile warnings via a synthetic close-over —
    // the caller hasn't called `send` yet, so we stash them and
    // attach to the next send's `onRawMessage`.
    const pendingWarnings = compiled.warnings.slice();

    const send = async (
        msg: UserMessage,
        sendOpts: FraguaPiAgentSendOptions = {},
    ): Promise<FraguaPiRunHandle> => {
        const prompt = typeof msg === 'string' ? msg : msg.text;
        const runId = sendOpts.runId ?? `run-${randomUUID()}`;
        // Drain pending warnings into the caller's onRawMessage tap if
        // present — that's the closest we have to a structured channel
        // pre-send. Otherwise drop silently (would need an
        // `agent.warning`-shaped HarnessEvent variant to expose).
        if (pendingWarnings.length > 0 && sendOpts.onRawMessage) {
            for (const w of pendingWarnings) {
                try {
                    sendOpts.onRawMessage({
                        // Synthetic event for warning propagation.
                        // pi-agent-core's union doesn't carry a
                        // `warning` variant; consumers should treat
                        // anything they don't recognise as opaque.
                        type: 'agent_start',
                        ...{ warning: w },
                    } as unknown as PiAgentEvent);
                } catch {
                    // best-effort
                }
            }
            pendingWarnings.length = 0;
        }
        return fraguaPiSend({
            agent: piAgent,
            prompt,
            runId,
            ...(sendOpts.onRawMessage !== undefined
                ? { onRawMessage: sendOpts.onRawMessage }
                : {}),
        });
    };

    const close = async (): Promise<void> => {
        try {
            piAgent.abort();
        } catch {
            // best-effort
        }
        // pi-agent-core has no `dispose()` — subscribers are released
        // when the wrapping RunHandle's `wait()` returns (via
        // `unsubscribe()` in send.ts). Nothing else to do here.
    };

    const getMessages = async (): Promise<HarnessMessage[]> => {
        const messages = piAgent.state.messages as PiAgentMessage[];
        const out: HarnessMessage[] = [];
        for (const m of messages) {
            out.push(...projectMessage(m));
        }
        return out;
    };

    return {
        id: agentId,
        send,
        close,
        getMessages,
    };
}

/** Build an api-key resolver from the caller's options. Returns
 *  `undefined` when nothing is configured — pi-agent-core's `Agent`
 *  then falls back to pi-ai's `getEnvApiKey` defaults. */
function buildApiKeyResolver(
    opts: FraguaPiCreateOptions,
):
    | ((provider: string) => Promise<string | undefined> | string | undefined)
    | undefined {
    if (opts.getApiKey) return opts.getApiKey;
    if (opts.apiKeyOverride) {
        const key = opts.apiKeyOverride;
        return (_provider: string) => key;
    }
    return undefined;
}

/** Project a pi-agent-core `AgentMessage` into canonical
 *  `HarnessMessage[]`. Each pi message can lower into 0 or more
 *  canonical messages (a single assistant turn carries one
 *  `assistant` entry; tool results land as separate `tool` entries). */
function projectMessage(m: PiAgentMessage): HarnessMessage[] {
    const mm = m as {
        role?: string;
        content?: unknown;
        timestamp?: number;
        toolCallId?: string;
        isError?: boolean;
    };
    const ts = typeof mm.timestamp === 'number' ? mm.timestamp : Date.now();
    if (mm.role === 'user') {
        const text =
            typeof mm.content === 'string'
                ? mm.content
                : Array.isArray(mm.content)
                  ? extractUserText(mm.content as unknown[])
                  : '';
        return [{ role: 'user', content: text, ts }];
    }
    if (mm.role === 'assistant') {
        const am = m as AssistantMessage;
        return [
            {
                role: 'assistant',
                content: extractAssistantBlocks(am),
                ts,
            },
        ];
    }
    if (mm.role === 'toolResult') {
        return [
            {
                role: 'tool',
                toolUseId: mm.toolCallId ?? '',
                output: mm.content ?? null,
                isError: Boolean(mm.isError),
                ts,
            },
        ];
    }
    // Custom / unknown messages don't project — caller can reach for
    // raw shape via the per-send `onRawMessage` tap.
    return [];
}

function extractAssistantBlocks(
    msg: AssistantMessage,
): Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'thinking'; text: string }
> {
    const out: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: 'thinking'; text: string }
    > = [];
    for (const block of msg.content) {
        if (block.type === 'text') {
            out.push({ type: 'text', text: block.text });
        } else if (block.type === 'thinking') {
            out.push({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'toolCall') {
            out.push({
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.arguments ?? {},
            });
        }
    }
    return out;
}

function extractUserText(content: unknown[]): string {
    const parts: string[] = [];
    for (const c of content) {
        const cc = c as { type?: string; text?: string };
        if (cc.type === 'text' && typeof cc.text === 'string') {
            parts.push(cc.text);
        }
    }
    return parts.join('');
}
