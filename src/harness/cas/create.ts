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
 * the backend wrapper previously called `casSend` directly to thread
 * CAS-private context. The backend now goes through
 * `casCreateAgent(def, opts).send(prompt)` — one compile per agent, not
 * per send. `createCasHarness.createAgent` spreads its `CreateOptions`
 * (incl. the opaque `hooks` pass-through) straight into this helper, so
 * the generic `Harness.createAgent` route and the direct `casCreateAgent`
 * route are a single source of truth — no per-call field (notably the
 * sandbox `hooks`) can be dropped on one path but not the other.
 */

import { randomUUID } from 'crypto';
import type { McpServerConfig, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { compileAgent } from '../../managed-agents/compile-agent';
import type { AgentContext, CompiledAgent, Transport } from '../../managed-agents/types';
import type { AgentDefinition, AgentHandle, RunHandle, SendOptions, ToolSpec, UserMessage } from '../types';
import { compileAgentToSdkOptions, type SdkHooks } from './compile';
import { casSendWithOptions } from './send';

/** Strongly-typed CAS create options. Superset of the canonical
 *  `CreateOptions` shape — the extra fields are CAS-private context the
 *  backend pre-resolves (provider creds, sandbox hooks, MCP record). */
export interface CasCreateOptions {
    /** Caller-supplied stable id; defaults to `cas-<uuid>`. Used as the
     *  transcript identity when `transcriptId` is absent, otherwise the
     *  SDK assigns its own. */
    agentId?: string;
    /** The Agent SDK's conversation transcript id (its `session_id`) —
     *  overrides `agentId` when both are set. Falls back to `agentId`
     *  when neither is supplied. */
    transcriptId?: string;
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
    /** Transcript persistence flag (pass-through to SDK). */
    persistTranscript?: boolean;
    /** Parent transcript id (the Agent SDK's `session_id`) when
     *  forking/resuming. */
    resumeTranscript?: string;
    /** When true + `resumeTranscript`, forks a fresh transcript instead
     *  of continuing the parent. */
    forkTranscript?: boolean;
    /** Built-in tool whitelist (SDK `Options.tools`). */
    tools?: string[];
    /** Default disallowed-tools list to apply when the declaration
     *  leaves it unset. */
    defaultDisallowedTools?: string[];
    /** Transport (`'in-process'` / `'mcp'` / `'laptop'` / `'vm'`) the
     *  agent is running under. When set, the platform-body composer
     *  reads the matching `_ernesto/<overlay>.md` and appends it to the
     *  system prompt on top of the universal `_ernesto/WORKSPACE.md`.
     *  Required for the agent to follow the platform's routing
     *  discipline ("look up URIs in `owns:` blocks", "don't glob for
     *  `routes/_index.md`", …). Absent → only the workflow body is the
     *  system prompt, and the agent has no idea what catalog conventions
     *  the platform uses. */
    transport?: Transport;
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
export async function casCreateAgent(def: AgentDefinition, opts: CasCreateOptions = {}): Promise<CasAgentHandle> {
    const compiled = coerceToCompiledAgent(def, opts);
    const agentId = opts.agentId ?? `cas-${randomUUID()}`;
    const transcriptId = opts.transcriptId ?? agentId;

    const sdkOptions = compileAgentToSdkOptions(compiled, {
        transcriptId,
        cwd: opts.cwd,
        abortController: opts.abortController,
        mcpServers: opts.mcpServers,
        providerEnv: opts.providerEnv,
        env: opts.env,
        hooks: opts.hooks,
        persistTranscript: opts.persistTranscript,
        resumeTranscript: opts.resumeTranscript,
        forkTranscript: opts.forkTranscript,
        // The compiled allowlist (lowered from `def.tools`) is the
        // native enforcement path and wins; `opts.tools` is the
        // pre-lowered CAS-private fallback for callers that pass the SDK
        // shape directly.
        tools: compiled.tools ?? opts.tools,
        defaultDisallowedTools: opts.defaultDisallowedTools,
    });

    const send = async (msg: UserMessage, sendOpts: CasAgentSendOptions = {}): Promise<RunHandle> => {
        const prompt = typeof msg === 'string' ? msg : msg.text;
        const runId = sendOpts.runId ?? `run-${randomUUID()}`;
        // Honor a per-send abort controller by swapping it into the
        // options for this query. Other fields stay byte-stable across
        // sends so the SDK's prompt cache treats them as identical.
        const perCallOptions =
            sendOpts.abortController !== undefined && sendOpts.abortController !== sdkOptions.abortController
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
 *
 * When a def DOES declare `tools[]`, the allowlist is lowered to the
 * SDK's `Options.tools` shape (a flat `string[]` of builtin names) and
 * carried onto the `CompiledAgent` so the surface is actually
 * RESTRICTED. The lowering fails closed: any tool spec that can't be an
 * SDK builtin allowlist entry (a `fn`/`mcp` spec) THROWS rather than
 * silently dropping the restriction — declaring a restriction the
 * engine can't enforce must refuse.
 */
function coerceToCompiledAgent(def: AgentDefinition, opts: CasCreateOptions): CompiledAgent {
    // Lower the declared allowlist first. Fails closed on any
    // unenforceable spec, so an untranslatable restriction never reaches
    // either branch as a silently-dropped allowlist.
    const toolAllowlist = toBuiltinAllowlist(def.tools);

    // Pass-through only when the caller hasn't asked for transport
    // composition. When `opts.transport` is set we must run
    // `compileAgent` so the platform body (`_ernesto/WORKSPACE.md` +
    // the per-transport overlay) lands in the system prompt — without
    // it the agent has no routing-catalog discipline.
    const isPreCompiled =
        opts.transport === undefined &&
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
            ...(toolAllowlist ? { tools: toolAllowlist } : {}),
        };
    }

    const modelId = typeof def.model === 'string' ? def.model : def.model.id;

    const ctx: AgentContext = {
        cwd: opts.cwd,
        transport: opts.transport,
    };

    const compiled = compileAgent(
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

    // `compileAgent`'s input (`AgentDeclaration`) carries no `tools`, so
    // it can't forward the allowlist itself — attach the lowered
    // allowlist onto its result so the restriction survives this branch.
    return toolAllowlist ? { ...compiled, tools: toolAllowlist } : compiled;
}

/**
 * Lower an `AgentDefinition.tools` allowlist (`ToolSpec[]`) to the SDK's
 * `Options.tools` shape — a flat `string[]` of builtin tool names.
 *
 * FAIL CLOSED: only `kind: 'builtin'` specs are expressible as an SDK
 * builtin allowlist. A `fn` or `mcp` spec cannot be honored as a
 * tool-surface restriction here, so we THROW rather than drop it — a
 * restriction the engine can't enforce must refuse, never silently
 * grant. Returns `undefined` when no allowlist is declared (no
 * restriction; the SDK default surface applies).
 */
function toBuiltinAllowlist(tools: ToolSpec[] | undefined): string[] | undefined {
    if (tools === undefined || tools.length === 0) return undefined;
    return tools.map((t) => {
        if (t.kind !== 'builtin') {
            throw new Error(
                `casCreateAgent: cannot enforce a tools allowlist containing a non-builtin spec ` +
                    `(kind '${t.kind}'). The SDK's Options.tools is a builtin-name allowlist only; ` +
                    `an unsupported/unenforceable tools restriction must fail closed rather than be dropped.`,
            );
        }
        return t.name;
    });
}
