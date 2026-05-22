/**
 * CAS-specific agent-creation helper.
 *
 * `casCreateAgent` is **not** on the canonical `Harness` interface — the
 * narrow `Harness.createAgent(def, opts)` (see `harness/types.ts`) stays
 * available for pure-Harness consumers. This helper is the CAS-aware
 * entry point used by backend wrappers (and any future CAS-aware caller)
 * that need to thread CAS-private context: pre-resolved `providerEnv`,
 * `SdkHooks` (workspace sandbox), an MCP server connection record, etc.
 *
 * Gap-2 closure from `agent-ops://harness-abstraction/step-1-findings.md`:
 * the backend wrapper previously called `casSend` directly because
 * `CreateOptions` doesn't carry `providerEnv`/`hooks`. With this helper
 * the backend goes through `casCreateAgent(def, opts).send(prompt)` —
 * one compile per agent, not per send, and a single source of truth for
 * the create flow shared with `createCasHarness.createAgent`.
 */

import { randomUUID } from 'crypto';
import type { McpServerConfig, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { compileAgent } from '../../managed-agents/compile-agent';
import type {
    AgentContext,
    CompiledAgent,
} from '../../managed-agents/types';
import type {
    AgentDefinition,
    AgentHandle,
    RunHandle,
    SendOptions,
    UserMessage,
} from '../types';
import { compileAgentToSdkOptions, type SdkHooks } from './compile';
import { casSendWithOptions } from './send';

/** Strongly-typed CAS create options. Superset of the canonical
 *  `CreateOptions` shape — the extra fields are CAS-private context the
 *  backend pre-resolves (provider creds, sandbox hooks, MCP record). */
export interface CasCreateOptions {
    /** Caller-supplied stable id; defaults to `cas-<uuid>`. Threaded
     *  into the SDK as `sessionId` when present, otherwise the SDK
     *  assigns its own. */
    agentId?: string;
    /** SDK session id — overrides `agentId` when both are set. Defaults
     *  to a `no-session` sentinel when neither is supplied. */
    sessionId?: string;
    /** Working directory bound to the agent run. */
    cwd?: string;
    /** Abort controller shared with the run. */
    abortController?: AbortController;
    /** MCP server map (in-process servers + remote stdio servers) —
     *  CAS-specific shape. */
    mcpServers?: Record<string, McpServerConfig>;
    /** Resolved provider env vars (ANTHROPIC_API_KEY / OPENROUTER_API_KEY
     *  / base url / etc) — CAS-specific. */
    providerEnv?: Record<string, string>;
    /** Extra env merged on top of providerEnv (HOME, XDG, etc). */
    env?: Record<string, string>;
    /** Sandbox hooks — CAS-specific structural type, opaque to the lib
     *  and passed through to `Options.hooks`. */
    hooks?: SdkHooks;
    /** Session persistence flag (pass-through to SDK). */
    persistSession?: boolean;
    /** Parent session id when forking/resuming. */
    resumeSessionId?: string;
    /** When true + `resumeSessionId`, forks a fresh session instead of
     *  continuing the parent. */
    forkSession?: boolean;
    /** Built-in tool whitelist (SDK `Options.tools`). */
    tools?: string[];
    /** Default disallowed-tools list to apply when the declaration
     *  leaves it unset. */
    defaultDisallowedTools?: string[];
}

/** Per-send CAS extensions on top of the canonical `SendOptions`. */
export interface CasAgentSendOptions extends SendOptions {
    /** Tap each raw `SDKMessage` as it arrives. The terminal-state path
     *  (`RunHandle.wait()`) still flows through the canonical
     *  `RunResult` surface; this lets in-flight callers that haven't
     *  fully migrated to `HarnessEvent` observe SDK-shape messages
     *  without double-iterating the underlying SDK iterator.
     *
     *  This is the gap-2 escape hatch for the subagent-runner-style
     *  per-turn formatting that depends on SDK-shape fields not yet on
     *  the canonical `HarnessEvent` taxonomy. */
    onRawMessage?: (msg: SDKMessage) => void;
}

/** CAS-typed agent handle. Structurally a canonical `AgentHandle` whose
 *  `send` accepts the CAS-extended `CasAgentSendOptions` instead of the
 *  narrow `SendOptions`. Backend wrappers (and any other CAS-aware
 *  caller) hold this type to keep `onRawMessage` typed. */
export interface CasAgentHandle extends AgentHandle {
    send(msg: UserMessage, opts?: CasAgentSendOptions): Promise<RunHandle>;
}

/**
 * Create a CAS-backed `AgentHandle`. The SDK `Options` are compiled
 * once here; each `agent.send(prompt)` issues a fresh `query()` against
 * the cached options.
 */
export async function casCreateAgent(
    def: AgentDefinition,
    opts: CasCreateOptions = {},
): Promise<CasAgentHandle> {
    const compiled = coerceToCompiledAgent(def, opts);
    const agentId = opts.agentId ?? `cas-${randomUUID()}`;
    const sessionId = opts.sessionId ?? agentId;

    const sdkOptions = compileAgentToSdkOptions(compiled, {
        sessionId,
        cwd: opts.cwd,
        abortController: opts.abortController,
        mcpServers: opts.mcpServers,
        providerEnv: opts.providerEnv,
        env: opts.env,
        hooks: opts.hooks,
        persistSession: opts.persistSession,
        resumeSessionId: opts.resumeSessionId,
        forkSession: opts.forkSession,
        tools: opts.tools,
        defaultDisallowedTools: opts.defaultDisallowedTools,
    });

    const send = async (
        msg: UserMessage,
        sendOpts: CasAgentSendOptions = {},
    ): Promise<RunHandle> => {
        const prompt = typeof msg === 'string' ? msg : msg.text;
        const runId = sendOpts.runId ?? `run-${randomUUID()}`;
        // Honor a per-send abort controller by swapping it into the
        // options for this query. Other fields stay byte-stable across
        // sends so the SDK's prompt cache treats them as identical.
        const perCallOptions =
            sendOpts.abortController !== undefined &&
            sendOpts.abortController !== sdkOptions.abortController
                ? { ...sdkOptions, abortController: sendOpts.abortController }
                : sdkOptions;
        return casSendWithOptions({
            options: perCallOptions,
            prompt,
            runId,
            onRawMessage: sendOpts.onRawMessage,
        });
    };

    return {
        id: agentId,
        send,
    };
}

/**
 * Coerce a harness-level `AgentDefinition` into a `CompiledAgent` the
 * SDK options compiler accepts. Two paths:
 *
 *   1. The def already structurally satisfies `CompiledAgent` — the
 *      backend wrapper's common case, where `compileAgent(workflow,
 *      …)` already ran upstream and the platform body is composed.
 *      Pass through to avoid double-composition.
 *   2. The def is a raw `AgentDefinition` (no upstream compile) — run
 *      `compileAgent` so platform body composition still happens.
 *
 * Pass-through criteria: `model` is a string and the def has no
 * `tools[]` / `subagents` (those require post-step-1 fn-tool / subagent
 * wiring not yet plumbed through CAS).
 */
function coerceToCompiledAgent(
    def: AgentDefinition,
    opts: CasCreateOptions,
): CompiledAgent {
    const isPreCompiled =
        typeof def.model === 'string' &&
        (def.tools === undefined || def.tools.length === 0) &&
        (def.subagents === undefined || def.subagents.length === 0) &&
        typeof def.maxTurns === 'number';

    if (isPreCompiled) {
        return {
            model: def.model as string,
            systemPrompt: def.systemPrompt,
            maxTurns: def.maxTurns!,
            mcpServers: def.mcpServers ?? [],
            outputFormat: def.outputFormat,
            disallowedTools: def.disallowedTools,
        };
    }

    const modelId =
        typeof def.model === 'string' ? def.model : def.model.id;

    const ctx: AgentContext = {
        session: {
            id: opts.agentId ?? opts.sessionId ?? 'no-session',
            cwd: opts.cwd,
        },
        // Backend Tier-A is the only call site that exercises CAS
        // today; callers from other tiers will thread `tier` through
        // once `CasCreateOptions.tier` lands.
        tier: undefined,
    };

    return compileAgent(
        {
            id: opts.agentId ?? 'agent',
            name: opts.agentId ?? 'agent',
            description: '',
            model: modelId,
            systemPrompt: def.systemPrompt,
            maxTurns: def.maxTurns ?? 20,
            mcpServers: def.mcpServers ?? [],
            outputFormat: def.outputFormat,
            disallowedTools: def.disallowedTools,
        },
        ctx,
    );
}
