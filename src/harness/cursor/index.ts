/**
 * Cursor harness — `@cursor/sdk` adapter.
 *
 * The peer dep is loaded lazily: importing this module triggers SDK
 * resolution. Consumers that don't ship Cursor never import
 * `ernesto/harness/cursor` and the peer can stay uninstalled.
 *
 * Capabilities matrix (Cursor column) — see
 * `agent-ops://harness-abstraction/capabilities.md` and the JSDoc on
 * `CURSOR_CAPABILITIES` below for the per-flag justification.
 *
 * **The MCP synthesis layer.** The step-2 architectural unlock lives
 * in `./mcp-bridge`. Fn-shaped tools become in-process HTTP MCP
 * servers, which Cursor accepts via its `mcpServers: { name: { url } }`
 * config. This is what lets `customFnTools = true` ship for Cursor
 * even though Cursor's native tool surface is MCP-only. The same
 * bridge will run backwards for fragua in step 3 (MCP servers
 * synthesized into fragua's fn-only `ToolRegistry`).
 */

import { Cursor } from '@cursor/sdk';
import type { McpServerConfig } from '@cursor/sdk';
import type {
    AgentDefinition,
    AgentHandle,
    CreateOptions,
    Harness,
    HarnessCapabilities,
    ModelInfo,
} from '../types';
import { cursorCreateAgent } from './create';

// Adapter internals (compile/events/send/create/mcp-bridge) are not
// re-exported: consumers use `createCursorHarness`; internal wiring +
// tests reach them via relative paths.

/** SDK re-exports — let Cursor-aware backend code import these without
 *  naming `@cursor/sdk` directly. Production code shouldn't reach
 *  across the abstraction; tests still may. The list is intentionally
 *  narrower than the CAS adapter's — Cursor exposes fewer
 *  consumer-facing primitives. */
export type {
    AgentOptions,
    SDKAgent,
    SDKMessage,
    McpServerConfig,
    ModelSelection,
    ModelListItem,
    Run,
    RunResult,
    RunStatus,
    SDKAgentInfo,
    SettingSource,
    InteractionUpdate,
} from '@cursor/sdk';
export { Agent, Cursor } from '@cursor/sdk';

/** Per-process env hooks the Cursor adapter accepts at construction. */
export interface CursorHarnessEnv {
    /** Cursor API key. Falls back to `process.env.CURSOR_API_KEY`. */
    apiKey?: string;
    /** Pre-resolved native MCP server map — passed to Cursor as
     *  `mcpServers` alongside the synth records the bridge builds. */
    mcpServers?: Record<string, McpServerConfig>;
    /** Default working directory. Per-create `cwd` overrides. */
    cwd?: string;
    /** Default sandbox toggle. Per-create `sandboxEnabled` overrides. */
    sandboxEnabled?: boolean;
    /** Override capabilities (test seam). */
    capabilities?: Partial<HarnessCapabilities>;
}

/**
 * Capability matrix — see
 * `agent-ops://harness-abstraction/capabilities.md` Cursor column.
 *
 * The flags below were verified against the actual `@cursor/sdk@1.0.13`
 * `.d.ts` shape (see `node_modules/@cursor/sdk/dist/esm/`). The doc
 * matrix prediction held for every flag.
 */
const CURSOR_CAPABILITIES: HarnessCapabilities = {
    /** `SendOptions.onDelta` fires per-token text updates
     *  (`TextDeltaUpdate`). See `agent.d.ts` SendOptions. */
    perTokenDeltas: true,

    /** No `Run.steer` or equivalent mid-turn API. Cursor commits to
     *  turn boundaries. */
    steer: false,

    /** No native pause/resume on `Run`. */
    pause: false,

    /** No HITL prompt surface in the SDK. */
    hitl: false,

    /** `AgentOptions.agents: Record<string, AgentDefinition>` plus
     *  `TaskToolCall` lifecycle messages (`tool-call-types.d.ts`). */
    subagents: true,

    /** **VIA the mcp-bridge synthesis layer**. Cursor accepts only
     *  MCP servers (stdio | http) as the tool surface; the bridge
     *  in `./mcp-bridge.ts` wraps each `ToolSpec.kind === 'fn'` into
     *  an in-process HTTP MCP server. Declared `true` at this
     *  surface — the synthesis is transparent to the canonical
     *  `Harness.createAgent` contract. */
    customFnTools: true,

    /** First-class via `AgentOptions.mcpServers` + per-send
     *  `SendOptions.mcpServers` overrides. */
    mcp: true,

    /** Cursor-curated model lineup only — no provider-direct dispatch. */
    multiProvider: false,

    /** `Agent.messages.list(agentId)` is sqlite-backed locally
     *  (`GetAgentMessagesOptions`). */
    listMessages: true,

    /** `Agent.list({ runtime: 'local' | 'cloud' })`. */
    listAgents: true,

    /** `Agent.resume(agentId, options?)` — re-attach to a prior agent
     *  by id. */
    resume: true,

    /** `SDKUserMessage.images?` — attachments via image refs. */
    attachments: true,

    /** No per-event cost surface — `RunResult` carries only
     *  `durationMs` + opaque `status`, no token/cost split. */
    costReporting: false,

    /** `Run.cancel()` operates at turn boundaries (Cursor's binary
     *  doesn't expose mid-response interrupt). */
    midResponseCancel: false,

    /** Cursor supports JSON-schema-shaped output via the model
     *  selection's params; the harness validates structurally on the
     *  way out. Marked `true` to align with the doc matrix; the
     *  adapter doesn't enforce a fast path beyond passing the
     *  schema through. */
    nativeStructuredOutput: true,
};

/**
 * Build a `Harness` backed by `@cursor/sdk`.
 */
export function createCursorHarness(env: CursorHarnessEnv = {}): Harness {
    const capabilities: HarnessCapabilities = {
        ...CURSOR_CAPABILITIES,
        ...(env.capabilities ?? {}),
    };

    const createAgent = async (
        def: AgentDefinition,
        opts: CreateOptions = {},
    ): Promise<AgentHandle> => {
        return cursorCreateAgent(def, {
            agentId: opts.agentId,
            cwd: opts.cwd ?? env.cwd,
            abortController: opts.abortController,
            mcpServers: env.mcpServers,
            apiKey: env.apiKey,
            sandboxEnabled: env.sandboxEnabled,
        });
    };

    const listModels = async (): Promise<ModelInfo[]> => {
        // `Cursor.models.list()` is cloud-only and requires an API
        // key — gate on env, return empty otherwise. The frontend
        // falls back to a static catalog in that case.
        if (!env.apiKey && !process.env.CURSOR_API_KEY) {
            return [];
        }
        try {
            const models = await Cursor.models.list({ apiKey: env.apiKey });
            return models.map((m) => ({
                id: m.id,
                name: m.displayName,
                provider: 'cursor',
            }));
        } catch {
            return [];
        }
    };

    const identify = async (): Promise<{
        authed: boolean;
        principal?: string;
    }> => {
        const key = env.apiKey || process.env.CURSOR_API_KEY;
        if (!key) return { authed: false };
        try {
            const me = await Cursor.me({ apiKey: env.apiKey });
            return {
                authed: true,
                principal: me.userEmail ?? me.apiKeyName,
            };
        } catch {
            // Key present but invalid — return authed:false so the
            // frontend prompts to re-auth.
            return { authed: false };
        }
    };

    return {
        capabilities,
        createAgent,
        listModels,
        identify,
    };
}
