/**
 * `AgentDefinition` → Cursor `AgentOptions` compiler.
 *
 * Source of truth for the SDK shape:
 *   `node_modules/@cursor/sdk/dist/esm/options.d.ts`
 *     - `AgentOptions`
 *     - `LocalAgentOptions` (`cwd`, `settingSources`, `sandboxOptions`)
 *     - `CloudAgentOptions` (`repos`, `env`, `envVars`, …)
 *     - `AgentDefinition` (the Cursor sub-agent shape: { description,
 *       prompt, model?, mcpServers? })
 *     - `McpServerConfig` (stdio | http/sse)
 *
 * The CAS adapter compiles to a single SDK `Options` blob; Cursor's
 * shape is split between top-level (`model`, `mcpServers`, `agents`,
 * `local`/`cloud`) and per-send (`onDelta`, `onStep`, `mcpServers`
 * override). The compile step builds the create-time blob; per-send
 * options are layered by `send.ts`.
 *
 * **Subagents pass-through.** `AgentDefinition.subagents` (harness IR)
 * maps to Cursor's `agents: Record<name, AgentDefinition>` because
 * Cursor's `AgentDefinition` carries a `description + prompt` pair.
 *
 * **MCP synthesis hand-off.** The `mcpServers` passed into Cursor is the
 * **union** of the caller-supplied native MCP servers and the synth
 * servers wrapping `ToolSpec.kind === 'fn'` entries — `mcp-bridge.ts`
 * does the actual wrap; this module only threads them through.
 */

import type { AgentOptions, McpServerConfig, AgentDefinition as CursorAgentDefinition, ModelSelection, SettingSource } from '@cursor/sdk';
import type { AgentDefinition, ModelRef, SubagentDef, ToolSpec } from '../types';
import type { SynthMcpServerConfig } from './mcp-bridge';

/** Compile context — what the harness adapter threads through from
 *  `cursorCreateAgent` to the compile step. Cursor-private. */
export interface CursorCompileContext {
    /** Working dir bound to the local agent. Cursor's `local.cwd`. */
    cwd?: string;
    /** Ambient setting sources to load (project/user/team/…). Defaults
     *  to `[]` (isolation) to match the CAS adapter's hygiene. */
    settingSources?: SettingSource[];
    /** Sandbox toggle (Cursor's `local.sandboxOptions.enabled`). */
    sandboxEnabled?: boolean;
    /** Cursor API key — if omitted, Cursor SDK falls back to
     *  `process.env.CURSOR_API_KEY`. */
    apiKey?: string;
    /** Pre-resolved MCP server config record (native Cursor MCP
     *  entries; e.g. `{ ernesto: { command, args } }`). */
    nativeMcpServers?: Record<string, McpServerConfig>;
    /** Synthesized MCP server record built by `mcp-bridge.ts` from
     *  any fn-shaped tools in `def.tools`. Merged with
     *  `nativeMcpServers` on the way to Cursor. */
    synthMcpServers?: Record<string, SynthMcpServerConfig>;
    /** Stable id Cursor will use; otherwise it assigns. */
    agentId?: string;
    /** Caller-controlled idempotency. */
    idempotencyKey?: string;
    /** Cloud-vs-local routing. Step 2 targets local; cloud is
     *  pass-through. */
    cloud?: AgentOptions['cloud'];
}

/**
 * Compile a harness `AgentDefinition` into Cursor's `AgentOptions`.
 *
 * Cursor doesn't have an analogue to CAS's `claude_code` preset, so the
 * canonical `SystemPromptConfig.type === 'preset'` collapses to the
 * `append` body (the preset body is platform-side at CAS and not
 * portable). The lib documents this lossiness rather than synthesizing
 * a fake preset.
 */
export function compileAgentToCursorOptions(def: AgentDefinition, ctx: CursorCompileContext): AgentOptions {
    const model = toModelSelection(def.model);

    // Merge native + synth MCP server records. Conflicts: synth wins
    // on name collision because synth keys are namespaced (`synth_<id>`)
    // by `mcp-bridge.ts`, so a clash means the caller used a colliding
    // native name — surface their override.
    const mcpServers: Record<string, McpServerConfig> = {};
    if (ctx.nativeMcpServers) {
        for (const [name, cfg] of Object.entries(ctx.nativeMcpServers)) {
            mcpServers[name] = cfg;
        }
    }
    if (ctx.synthMcpServers) {
        for (const [name, cfg] of Object.entries(ctx.synthMcpServers)) {
            // The synth config is structurally a subset of Cursor's
            // McpServerConfig (the `{ url }` shape). The cast is
            // documented at the boundary — see `mcp-bridge.ts`.
            mcpServers[name] = cfg as McpServerConfig;
        }
    }

    const agents = compileSubagents(def.subagents);

    const opts: AgentOptions = {
        model,
        apiKey: ctx.apiKey,
        agentId: ctx.agentId,
        idempotencyKey: ctx.idempotencyKey,
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        ...(agents !== undefined ? { agents } : {}),
    };

    if (ctx.cloud !== undefined) {
        opts.cloud = ctx.cloud;
    } else {
        // Default to local runtime — the only mode where `cwd` /
        // `settingSources` apply.
        opts.local = {
            ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
            // Isolation: don't auto-load project/user/team settings
            // unless the caller asks for them. Mirrors the CAS
            // adapter's `settingSources: []`.
            settingSources: ctx.settingSources ?? [],
            ...(ctx.sandboxEnabled !== undefined ? { sandboxOptions: { enabled: ctx.sandboxEnabled } } : {}),
        };
    }

    return opts;
}

/** Coerce a harness `ModelRef | string` into Cursor's `ModelSelection`
 *  (`{ id, params? }`). */
function toModelSelection(model: string | ModelRef): ModelSelection {
    if (typeof model === 'string') {
        return { id: model };
    }
    const params = model.params;
    if (params && typeof params === 'object') {
        return {
            id: model.id,
            params: Object.entries(params).map(([id, value]) => ({
                id,
                value: typeof value === 'string' ? value : JSON.stringify(value),
            })),
        };
    }
    return { id: model.id };
}

/** Compile the harness subagent list into Cursor's `agents` record. */
function compileSubagents(subagents: SubagentDef[] | undefined): Record<string, CursorAgentDefinition> | undefined {
    if (!subagents || subagents.length === 0) return undefined;
    const out: Record<string, CursorAgentDefinition> = {};
    for (const sub of subagents) {
        const cursorAgent: CursorAgentDefinition = {
            description: sub.description,
            prompt: sub.systemPrompt ?? '',
        };
        if (sub.model !== undefined) {
            cursorAgent.model = toModelSelection(sub.model);
        }
        // Subagent tools: Cursor's per-subagent `mcpServers` is the
        // only tool surface — fn tools synthesized at the parent
        // level are already in `mcpServers`. Per-subagent narrowing
        // would require a parallel synth pass; deferred to step 3
        // when fragua needs subagent-level tool partitioning.
        out[sub.slug] = cursorAgent;
        void (sub.tools as ToolSpec[] | undefined);
    }
    return out;
}
