/**
 * `AgentDefinition` → pi-agent-core `AgentOptions` compiler.
 *
 * Source of truth for the SDK shape:
 *   `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts`
 *     - `AgentOptions` (initialState, streamFn, getApiKey, sessionId,
 *       transport, …)
 *     - `AgentState.systemPrompt | model | tools | messages`
 *   `node_modules/@mariozechner/pi-ai/dist/types.d.ts`
 *     - `Model<TApi>` — resolved via `getModel(provider, modelId)`
 *
 * **Model id format.** Per `interface.md`, fragua's `ModelRef.id`
 * carries a provider-qualified id like `anthropic/claude-opus-4-7`,
 * `openai/gpt-4o`, `ollama/llama3`, `openrouter/anthropic/claude-3.5`.
 * We split on the first `/` to recover the (provider, modelId) pair
 * pi-ai's `getModel` expects. The CAS adapter's `claude-opus-4-7`
 * (without a provider prefix) is also accepted: when there's no `/`,
 * we default to the harness env's `defaultProvider` (or `anthropic`
 * if unset).
 *
 * **Tools.** Harness `ToolSpec.kind === 'fn'` lowers directly into a
 * pi-agent-core `AgentTool` (pi-ai accepts fn tools natively; this is
 * the inverse direction from Cursor's MCP-wrapping bridge). The lib's
 * `ToolSpec.kind === 'mcp'` is **not** supported by this compiler at
 * step 3 — fragua-the-project ships `wrapMcpServerAsFnTools` upstream
 * in its `@fragua/workspace.ToolRegistry` (the `mcp` capability flag
 * lights up only post-bridge per the doc). Until that bridge ships in
 * ernesto-lib, an `mcp`-kind tool emits a structured warning and is
 * dropped.
 *
 * **No subagents at the harness layer.** pi-agent-core has no nested-
 * run lifecycle. Fragua-the-project synthesises subagent semantics
 * one level above (subworkflow nodes). The compiler ignores
 * `def.subagents` and the capability matrix flips `subagents` to
 * `false` for the harness layer (the doc's `synthesized` annotation
 * refers to the workflow engine, not the harness).
 */

import type { AgentOptions as PiAgentOptions, AgentTool } from '@mariozechner/pi-agent-core';
import { Type, getModel as piGetModel } from '@mariozechner/pi-ai';
import type { Model, TSchema } from '@mariozechner/pi-ai';
import type { AgentDefinition, ModelRef, ToolSpec } from '../types';

/** Pi-ai providers we recognise. The pi-ai `getModel` accepts more
 *  (Bedrock, Vertex, mistralai, openrouter, etc.), but the harness
 *  surface only exposes the canonical five from `capabilities.md`. */
export type FraguaPiProvider = 'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter';

/** Compile context — what the harness adapter threads through from
 *  `fraguaPiCreateAgent` to the compile step. Fragua-pi-private. */
export interface FraguaPiCompileContext {
    /** Default provider when `model` lacks a `provider/` prefix. */
    defaultProvider?: FraguaPiProvider;
    /** Caller-supplied resolver — overrides the default `getModel`
     *  lookup. Used by tests + by any consumer wiring a custom
     *  provider registry (e.g. fragua's `ModelRegistry`). */
    resolveModel?: (provider: string, modelId: string) => Model<string>;
    /** Caller-supplied API key resolver. Forwarded to pi-agent-core's
     *  `Agent.getApiKey`. */
    getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
    /** The Agent SDK's conversation transcript id (its `session_id`),
     *  used for provider-cache hints (Anthropic / OpenAI-Responses use
     *  this). */
    transcriptId?: string;
    /** Default disallowed-tools list applied when the declaration
     *  leaves it unset. Fn-shaped tools whose `name` is in the merged
     *  disallowed list are silently dropped. */
    defaultDisallowedTools?: string[];
}

/** Compiled output. We hand back the pieces `pi-agent-core`'s `Agent`
 *  constructor needs, not a full `AgentOptions` blob — the
 *  `streamFn`/`convertToLlm` defaults live in pi-agent-core itself
 *  and we don't override them. */
export interface CompiledFraguaPiOptions {
    /** System prompt body. pi-agent-core puts this on `AgentState`. */
    systemPrompt: string;
    /** Resolved pi-ai `Model<TApi>`. */
    model: Model<string>;
    /** pi-agent-core tool list. */
    tools: AgentTool[];
    /** Caller-supplied API-key resolver. */
    getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
    /** The Agent SDK's conversation transcript id (its `session_id`),
     *  for provider-cache hints. */
    transcriptId?: string;
    /** Diagnostic warnings emitted during compile — surfaced to the
     *  caller (typically appended to `agent.warning` events). */
    warnings: string[];
}

/**
 * Compile a harness `AgentDefinition` into the pieces needed to
 * construct a pi-agent-core `Agent`.
 */
export function compileAgentToFraguaPiOptions(def: AgentDefinition, ctx: FraguaPiCompileContext = {}): CompiledFraguaPiOptions {
    const warnings: string[] = [];

    // System prompt — collapse `SystemPromptConfig` to plain text.
    // The CAS-only `'claude_code'` preset is meaningless to pi-ai
    // (no provider-side equivalent); we use the `append` body when
    // present, drop the preset marker.
    const systemPrompt = typeof def.systemPrompt === 'string' ? def.systemPrompt : (def.systemPrompt.append ?? '');

    // Model resolution.
    const { provider, modelId } = parseModelId(def.model, ctx.defaultProvider);
    const resolver =
        ctx.resolveModel ??
        ((p: string, m: string): Model<string> => {
            // pi-ai's `getModel` is overloaded with `KnownProvider`;
            // we intentionally accept any string so custom/faux
            // providers work — same trick fragua-the-project uses
            // in `PiLlmBackend`.
            return (piGetModel as unknown as (provider: string, modelId: string) => Model<string>)(p, m);
        });
    const model = resolver(provider, modelId);

    // Tools — drop `mcp`-kind for now (pre-bridge), drop `builtin`-kind
    // (no pi-ai builtin tool surface), pass `fn` through.
    const tools: AgentTool[] = [];
    const disallowed = new Set(def.disallowedTools ?? ctx.defaultDisallowedTools ?? []);
    for (const spec of def.tools ?? []) {
        if (spec.kind === 'fn') {
            if (disallowed.has(spec.name)) continue;
            tools.push(fnToolSpecToAgentTool(spec));
        } else if (spec.kind === 'mcp') {
            warnings.push(
                `fragua-pi: dropping mcp tool '${spec.serverName}' — ` +
                    'native MCP support is gated on the harness mcp-bridge ' +
                    '(pre-step-1 lib work). Wire the bridge in fragua-side ' +
                    'ToolRegistry instead.',
            );
        } else if (spec.kind === 'builtin') {
            warnings.push(
                `fragua-pi: dropping builtin tool '${spec.name}' — ` +
                    'pi-ai has no builtin-tool surface; lower to a fn tool ' +
                    "or rely on fragua-the-project's ToolRegistry.",
            );
        }
    }

    const out: CompiledFraguaPiOptions = {
        systemPrompt,
        model,
        tools,
        warnings,
    };
    if (ctx.getApiKey !== undefined) out.getApiKey = ctx.getApiKey;
    if (ctx.transcriptId !== undefined) out.transcriptId = ctx.transcriptId;
    return out;
}

/**
 * Parse a harness `ModelRef | string` into `(provider, modelId)`.
 *
 * - `'anthropic/claude-opus-4-7'` → `{ anthropic, claude-opus-4-7 }`
 * - `'claude-opus-4-7'` → `{ <defaultProvider>, claude-opus-4-7 }`
 * - `{ id: 'openai/gpt-4o' }` → `{ openai, gpt-4o }`
 *
 * Multi-segment ids (openrouter's `anthropic/claude-3.5`) preserve
 * everything after the first `/` as the modelId.
 */
function parseModelId(model: string | ModelRef, defaultProvider: FraguaPiProvider | undefined): { provider: string; modelId: string } {
    const id = typeof model === 'string' ? model : model.id;
    const slash = id.indexOf('/');
    if (slash > 0) {
        return {
            provider: id.slice(0, slash),
            modelId: id.slice(slash + 1),
        };
    }
    return {
        provider: defaultProvider ?? 'anthropic',
        modelId: id,
    };
}

/**
 * Lower a harness fn `ToolSpec` into a pi-agent-core `AgentTool`.
 *
 * Wraps the user's `(input: unknown) => Promise<unknown>` handler into
 * pi-agent-core's `execute(toolCallId, params, signal, onUpdate)`
 * shape. The output is coerced to a `[{ type: 'text', text: … }]`
 * content block (pi-ai requires `content` to be text/image only —
 * structured outputs land in `details`). When the handler throws, we
 * re-throw so the agent loop's error-tool-result fallback fires.
 */
export function fnToolSpecToAgentTool(spec: Extract<ToolSpec, { kind: 'fn' }>): AgentTool {
    // The lib's JSON-schema is a permissive `Record<string, unknown>`;
    // pi-agent-core / typebox wants a `TSchema`. We wrap the raw
    // schema via `Type.Unsafe` so the validator passes everything
    // through to the handler — the handler's own validation is the
    // source of truth, mirroring how fragua does it. Empty schema
    // collapses to `Type.Object({})`.
    const rawSchema = spec.schema ?? {};
    const parameters: TSchema = Object.keys(rawSchema).length === 0 ? Type.Object({}) : Type.Unsafe(rawSchema);
    return {
        name: spec.name,
        label: spec.name,
        description: spec.description,
        parameters,
        async execute(_toolCallId, params, _signal, _onUpdate) {
            const result = await spec.handler(params);
            const text = typeof result === 'string' ? result : JSON.stringify(result);
            return {
                content: [{ type: 'text', text }],
                details: result,
            };
        },
    };
}
