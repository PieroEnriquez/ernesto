/**
 * fragua-pi harness — `@mariozechner/pi-agent-core` + `@mariozechner/pi-ai`
 * adapter.
 *
 * Architecture A — "thin pi-ai wrapper". Imports pi-agent-core + pi-ai
 * directly into the ernesto-lib harness; the harness wraps
 * pi-agent-core's `Agent` and exposes it via the canonical `Harness`
 * shape. Same approach as CAS (wraps `@anthropic-ai/claude-agent-sdk`)
 * and Cursor (wraps `@cursor/sdk`). Fragua-the-project's `PiLlmBackend`
 * is a sibling reference, not a dependency — we do not import any
 * `@fragua/*` package here.
 *
 * The peer deps are loaded lazily: importing this module triggers SDK
 * resolution. Consumers that don't ship fragua-pi never import
 * `ernesto/harness/fragua-pi` and the peers can stay uninstalled.
 *
 * Capability matrix (fragua column) — see
 * `agent-ops://harness-abstraction/capabilities.md` and the JSDoc on
 * `FRAGUA_PI_CAPABILITIES` below for the per-flag justification. **Two
 * flags diverge from the doc's prediction:**
 *
 * - `perTokenDeltas` = **true**, not `false`. pi-agent-core's
 *   `message_update` event carries `text_delta` per token. The doc's
 *   prediction was based on fragua's fact-event granularity (which is
 *   per-message), but at the *harness* layer pi-ai streams tokens.
 *
 * - `subagents` = **false**, not `true (synthesized)`. The synthesis
 *   the doc describes happens at fragua's workflow-engine layer
 *   (subworkflow nodes spawn child runs), not at the harness layer.
 *   The fragua-pi harness wraps a single pi-agent-core `Agent`, which
 *   has no nested-run lifecycle.
 *
 * - `hitl` = **false**, not `true`. Same reason — HITL is a
 *   workflow-engine concept (fragua's intent endpoint), not a pi-ai
 *   concept. The harness has no HITL surface to expose.
 *
 * - `pause` = **false**, not `true`. pi-agent-core has `abort()` but
 *   no resumable pause. Same workflow-engine vs harness distinction.
 *
 * - `mcp` = **false**, not `true (post-bridge)`. The bridge mentioned
 *   in the doc lives in step-2 Cursor work (`harness/cursor/mcp-bridge`)
 *   and runs `fn → MCP`. The fragua-pi direction (`MCP → fn`) is not
 *   yet wired in ernesto-lib; fragua-the-project does it inside its
 *   own `@fragua/workspace.ToolRegistry`.
 *
 * - `listAgents` = **false**, not `true`. pi-agent-core is per-process
 *   state; there's no agent registry to enumerate at the harness layer.
 *
 * - `resume` = **false**, not `true`. pi-agent-core can hydrate an
 *   `Agent` from a prior transcript via `initialState.messages`, but
 *   there's no harness-level "resume by id" surface (the durable id
 *   store is fragua's `messages` table, one level up).
 */

import {
    findEnvKeys,
    getEnvApiKey,
    getProviders,
    getModels,
} from '@mariozechner/pi-ai';
import type {
    AgentDefinition,
    AgentHandle,
    CreateOptions,
    Harness,
    HarnessCapabilities,
    ModelInfo,
} from '../types';
import { fraguaPiCreateAgent } from './create';

export { compileAgentToFraguaPiOptions, fnToolSpecToAgentTool } from './compile';
export type {
    FraguaPiCompileContext,
    FraguaPiProvider,
    CompiledFraguaPiOptions,
} from './compile';
export {
    mapPiAgentStream,
    mapPiAgentEvent,
    mapStopReason,
    createTranslatorState,
} from './events';
export type { TranslatorState } from './events';
export {
    fraguaPiSend,
    fraguaPiAgentToRunHandle,
} from './send';
export type {
    FraguaPiSendInput,
    FraguaPiSendOptionsExt,
    FraguaPiAgentToHandleOptions,
    FraguaPiRunHandle,
} from './send';
export { fraguaPiCreateAgent } from './create';
export type {
    FraguaPiCreateOptions,
    FraguaPiAgentSendOptions,
    FraguaPiAgentHandle,
} from './create';

/** SDK re-exports — let pi-aware backend code import these without
 *  naming `@mariozechner/*` directly. */
export {
    Agent,
} from '@mariozechner/pi-agent-core';
export type {
    AgentOptions as PiAgentOptions,
    AgentEvent as PiAgentEvent,
    AgentMessage as PiAgentMessage,
    AgentTool as PiAgentTool,
    AgentState as PiAgentState,
} from '@mariozechner/pi-agent-core';
export type {
    AssistantMessage as PiAssistantMessage,
    AssistantMessageEvent as PiAssistantMessageEvent,
    Model as PiModel,
    ToolResultMessage as PiToolResultMessage,
    UserMessage as PiUserMessage,
    Usage as PiUsage,
} from '@mariozechner/pi-ai';

/** Per-process env hooks the fragua-pi adapter accepts at construction. */
export interface FraguaPiHarnessEnv {
    /** Per-provider API keys. Falls back to pi-ai's
     *  `getEnvApiKey(provider)` (which reads `ANTHROPIC_API_KEY`,
     *  `OPENAI_API_KEY`, …) when a provider's key is not in this map. */
    apiKeys?: Partial<
        Record<
            'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter',
            string
        >
    >;
    /** Default provider when a `ModelRef.id` lacks a `provider/` prefix.
     *  Defaults to `anthropic`. */
    defaultProvider?:
        | 'anthropic'
        | 'openai'
        | 'google'
        | 'ollama'
        | 'openrouter';
    /** Default tool restrictions applied across all created agents. */
    defaults?: { disallowedTools?: string[] };
    /** Override capabilities (test seam). */
    capabilities?: Partial<HarnessCapabilities>;
    /** Default working directory applied to every `createAgent` when
     *  the caller doesn't override. Informational — pi-agent-core has
     *  no `cwd` field. */
    cwd?: string;
}

/**
 * Capability matrix — fragua column.
 *
 * The flags below were verified against the actual
 * `@mariozechner/pi-agent-core@0.73.1` `.d.ts` shape (see
 * `node_modules/@mariozechner/pi-agent-core/dist/`). Several of the
 * doc's predictions reflect fragua-the-project's workflow-engine
 * realities, not the pi-ai-layer reality this harness implements;
 * those are flipped here and called out in `step-3-findings.md`.
 */
const FRAGUA_PI_CAPABILITIES: HarnessCapabilities = {
    /** **Doc says `false`; we ship `true`.** pi-agent-core's
     *  `message_update` event carries an `AssistantMessageEvent` whose
     *  `text_delta` variant streams per-token text. The doc's
     *  prediction was rooted in fragua's fact-event taxonomy
     *  (per-message), but the harness sits below that. */
    perTokenDeltas: true,

    /** `Agent.steer(message)` queues a user message for the next turn.
     *  Drained after the current assistant turn finishes its tool calls
     *  per `steeringMode`. */
    steer: true,

    /** No pause/resume on pi-agent-core. `Agent.abort()` is a one-way
     *  terminal cancel. **Doc says `true`; we ship `false`.** Pause is
     *  a workflow-engine concept (fragua-side); the harness can't
     *  honour it. */
    pause: false,

    /** No HITL prompt surface in pi-agent-core. **Doc says `true`; we
     *  ship `false`.** HITL is fragua's intent-endpoint feature, not
     *  pi-ai's. */
    hitl: false,

    /** pi-agent-core has no nested-run lifecycle. **Doc says `true
     *  (synthesized)`; we ship `false`.** The synthesis the doc
     *  describes happens at fragua's workflow-engine layer. */
    subagents: false,

    /** First-class via pi-agent-core's `AgentTool` shape. The
     *  compile step lowers `ToolSpec.kind === 'fn'` directly into an
     *  `AgentTool`. */
    customFnTools: true,

    /** **Doc says `true (post-bridge)`; we ship `false`.** The
     *  fragua-direction (`MCP → fn`) bridge does not yet live in
     *  ernesto-lib. fragua-the-project's `@fragua/workspace.ToolRegistry`
     *  handles MCP server discovery + tool wrapping there; the harness
     *  receives already-wrapped fn tools. */
    mcp: false,

    /** Multi-provider dispatch — Anthropic / OpenAI / Google / Ollama /
     *  OpenRouter. pi-ai's `getModel(provider, modelId)` resolves the
     *  right `Model<TApi>` and pi-agent-core dispatches accordingly. */
    multiProvider: true,

    /** `agent.state.messages` carries the in-process transcript.
     *  Projected into canonical `HarnessMessage[]` by
     *  `FraguaPiAgentHandle.getMessages()`. The transcript is
     *  per-`Agent`-instance, not durable across process restarts —
     *  durability lives in fragua's `messages` table one level up. */
    listMessages: true,

    /** No agent registry at the harness layer. **Doc says `true`; we
     *  ship `false`.** */
    listAgents: false,

    /** No "resume by id" surface at the harness layer. **Doc says
     *  `true (event replay)`; we ship `false`.** Caller can pre-
     *  populate `initialState.messages` via the lower-level
     *  `compileAgentToFraguaPiOptions` + `new Agent(...)` if needed. */
    resume: false,

    /** pi-ai's `UserMessage.content` accepts `TextContent | ImageContent`
     *  blocks. The harness's `UserMessage` shape supports an
     *  `attachments` array, but the lowering path isn't wired yet —
     *  per the doc's `partial`, we ship `false` at this surface until
     *  the lowering lands. */
    attachments: false,

    /** Pi-ai stamps every `AssistantMessage` with a `Usage` object
     *  carrying input/output/cache + USD cost. Emitted as one terminal
     *  `usage` event per assistant message. */
    costReporting: true,

    /** `Agent.abort()` forwards through pi-ai's `StreamOptions.signal`
     *  to the provider SDK's fetch, which tears the connection down
     *  mid-response. */
    midResponseCancel: true,

    /** **Doc says `post-validate`; we ship `false`.** pi-ai exposes a
     *  schema parameter but doesn't fast-path JSON-schema enforcement
     *  at the harness layer. Consumers wanting structured output
     *  should post-validate. */
    nativeStructuredOutput: false,
};

/**
 * Build a `Harness` backed by `@mariozechner/pi-agent-core` +
 * `@mariozechner/pi-ai`.
 */
export function createFraguaPiHarness(
    env: FraguaPiHarnessEnv = {},
): Harness {
    const capabilities: HarnessCapabilities = {
        ...FRAGUA_PI_CAPABILITIES,
        ...(env.capabilities ?? {}),
    };

    const resolveApiKey = (
        provider: string,
    ): string | undefined => {
        const fromEnv = env.apiKeys?.[
            provider as keyof NonNullable<FraguaPiHarnessEnv['apiKeys']>
        ];
        if (fromEnv) return fromEnv;
        try {
            return getEnvApiKey(provider) ?? undefined;
        } catch {
            return undefined;
        }
    };

    const createAgent = async (
        def: AgentDefinition,
        opts: CreateOptions = {},
    ): Promise<AgentHandle> => {
        const createOpts: Parameters<typeof fraguaPiCreateAgent>[1] = {};
        if (opts.agentId !== undefined) createOpts.transcriptId = opts.agentId;
        if (opts.cwd !== undefined) createOpts.cwd = opts.cwd;
        else if (env.cwd !== undefined) createOpts.cwd = env.cwd;
        if (opts.env !== undefined) createOpts.env = opts.env;
        if (opts.abortController !== undefined) {
            createOpts.abortController = opts.abortController;
        }
        if (env.defaultProvider !== undefined) {
            createOpts.providerOverride = env.defaultProvider;
        }
        if (env.defaults?.disallowedTools !== undefined) {
            createOpts.defaultDisallowedTools = env.defaults.disallowedTools;
        }
        // Wire harness-env apiKeys into a per-provider resolver. The
        // resolver runs lazily per LLM call so a key swapped after
        // construction is honoured.
        createOpts.getApiKey = (provider: string) => resolveApiKey(provider);
        return fraguaPiCreateAgent(def, createOpts);
    };

    const listModels = async (): Promise<ModelInfo[]> => {
        // pi-ai's `getModels(provider)` returns the static catalog per
        // provider. Iterate over all known providers and collect.
        // Provider list comes from pi-ai's `getProviders()` (the
        // `KnownProvider` union materialized at runtime).
        const out: ModelInfo[] = [];
        try {
            const providers = getProviders();
            for (const p of providers) {
                try {
                    const models = getModels(p);
                    for (const m of models) {
                        out.push({
                            id: `${m.provider}/${m.id}`,
                            name: m.name,
                            provider: String(m.provider),
                            contextWindow: m.contextWindow,
                        });
                    }
                } catch {
                    // Provider catalog read failed — skip silently.
                }
            }
        } catch {
            // pi-ai builtin catalog not loaded — return empty.
        }
        return out;
    };

    const identify = async (): Promise<{
        authed: boolean;
        principal?: string;
    }> => {
        // Authed iff at least one provider has a resolvable API key.
        // No user-account probe in pi-ai (it's a multi-provider client,
        // not a single-vendor SDK like Cursor / Anthropic) — so
        // `principal` falls back to the provider with a key, prefixed.
        const candidates: Array<
            'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter'
        > = ['anthropic', 'openai', 'google', 'ollama', 'openrouter'];
        for (const p of candidates) {
            const key = resolveApiKey(p);
            if (key) {
                return { authed: true, principal: `${p}:configured` };
            }
            try {
                const envKeys = findEnvKeys(p);
                if (envKeys && envKeys.length > 0) {
                    // Env var present but no key resolved means the
                    // var name was found but its value was missing —
                    // treat as unauthed.
                    continue;
                }
            } catch {
                // ignore
            }
        }
        return { authed: false };
    };

    return {
        capabilities,
        createAgent,
        listModels,
        identify,
    };
}
