/**
 * CAS harness — `@anthropic-ai/claude-agent-sdk` adapter.
 *
 * The peer dep is loaded lazily: importing this module triggers SDK
 * resolution. Consumers that don't ship CAS should never import
 * `ernesto/harness/cas` and the peer can stay uninstalled.
 *
 * Capabilities matrix (CAS column) — see
 * `agent-ops://harness-abstraction/capabilities.md`.
 */

import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type {
    AgentDefinition,
    AgentHandle,
    CreateOptions,
    Harness,
    HarnessCapabilities,
    ModelInfo,
} from '../types';
import type { Transport } from '../../managed-agents/types';
import { casCreateAgent } from './create';
import type { SdkHooks } from './compile';

// Adapter internals (compile/events/send/create) are not re-exported:
// consumers use `createCasHarness`; the lib's own modules + tests reach
// them via relative paths. `SdkHooks` is the one type backend needs.
export type { SdkHooks } from './compile';

/**
 * SDK re-exports — let CAS-aware host code import these without
 * naming `@anthropic-ai/claude-agent-sdk` directly. Production code
 * shouldn't reach across the abstraction; tests still may.
 *
 * The union below is exactly what the host's production code imports —
 * no over-exporting. Anything not on this list is either tests-only
 * (which may keep importing the SDK directly) or a CAS-internal
 * concern that should not surface to host callers.
 *
 * Hook-shape note: we deliberately DO NOT re-export the SDK's nominal
 * `HookEvent` enum. The host may ship a different SDK minor (0.3.143)
 * than this lib pins (0.3.148); pnpm's peer-dep resolution can land
 * two structurally-identical-but-nominally-distinct copies of
 * `HookEvent` in the same compilation, which won't unify. Host
 * code that needs the "hooks blob shape" should use the structural
 * `SdkHooks` (`Record<string, unknown>`) exported by `./compile`
 * above. Leaf hook input/output types (`HookCallbackMatcher`,
 * `PreToolUseHookInput`, `SyncHookJSONOutput`) are safer to
 * re-export — they don't appear as Record-keys and the SDK
 * validates them structurally at runtime.
 */
export type {
    Options,
    McpServerConfig,
    McpSdkServerConfigWithInstance,
    SDKMessage,
    Query,
    PreToolUseHookInput,
    SyncHookJSONOutput,
    JsonSchemaOutputFormat,
} from '@anthropic-ai/claude-agent-sdk';

/**
 * Value re-exports — MCP-server-creation primitives the host uses
 * to build in-process tools, plus the top-level `query` entry point.
 * These are CAS-specific today; Cursor / fragua will expose
 * analogous primitives shaped differently.
 */
export { tool, createSdkMcpServer, query } from '@anthropic-ai/claude-agent-sdk';

/** Per-process env hooks the CAS adapter accepts at construction. The
 *  caller (the host application) resolves provider creds itself and
 *  passes them in. */
export interface CasHarnessEnv {
    /** Pre-resolved provider env (api keys, base url). Threaded into
     *  every run's `Options.env`. */
    providerEnv?: Record<string, string>;
    /** MCP server connection record. The host's MCP registry resolves
     *  ids to connection configs; the harness just threads them. */
    mcpServers?: Record<string, McpServerConfig>;
    /** Default disallowed-tools fallback when the def doesn't specify. */
    defaults?: { disallowedTools?: string[] };
    /** Override capabilities (test seam). */
    capabilities?: Partial<HarnessCapabilities>;
    /** Which transport the harness is deployed under, carried through
     *  `ctx.transport`: `'in-process'`, `'mcp'` (a remote MCP client),
     *  `'laptop'`, or `'vm'`. The platform-body composer selects the
     *  matching platform body and appends it to the system prompt —
     *  without it the agent gets no platform routing discipline (catalog
     *  lookup rules, sensitive topics, citation requirements). Set once
     *  per process at boot. */
    transport?: Transport;
}

const CAS_CAPABILITIES: HarnessCapabilities = {
    perTokenDeltas: true,
    steer: false,
    pause: false,
    hitl: false,
    subagents: true,
    customFnTools: true,
    mcp: true,
    multiProvider: false,
    listMessages: false,
    listAgents: false,
    resume: false,
    attachments: true,
    costReporting: true,
    midResponseCancel: true,
    nativeStructuredOutput: true,
};

/**
 * Build a `Harness` backed by `@anthropic-ai/claude-agent-sdk`.
 */
export function createCasHarness(env: CasHarnessEnv = {}): Harness {
    const capabilities: HarnessCapabilities = {
        ...CAS_CAPABILITIES,
        ...(env.capabilities ?? {}),
    };

    const createAgent = async (
        def: AgentDefinition,
        opts: CreateOptions = {},
    ): Promise<AgentHandle> => {
        // Single source of truth: route the harness-level create
        // through `casCreateAgent`, SPREADING the per-call `CreateOptions`
        // straight through and folding the construction-time env
        // (provider env, MCP servers, disallowed-tool defaults, transport)
        // on top. We spread rather than re-list each field on purpose: a
        // hand-maintained field list here is a second source of truth that
        // drifts from `CreateOptions` — that is exactly how `hooks` was
        // silently dropped (nullifying the FS sandbox on this path) until
        // this was fixed. Per-call sandbox hooks now flow through the
        // normal `Harness.createAgent` route; no need to reach for
        // `casCreateAgent` directly.
        // Per-call mcpServers (from CreateOptions) win on key collision
        // with the harness's env-level defaults. Use case: the in-process
        // transport injects a per-run `ernesto` MCP server closing over
        // workdir + user + scopes alongside the boot-wired `ui` server.
        const mergedMcpServers =
            opts.mcpServers !== undefined || env.mcpServers !== undefined
                ? {
                    ...(env.mcpServers ?? {}),
                    ...((opts.mcpServers as Record<string, McpServerConfig> | undefined) ?? {}),
                }
                : undefined;
        return casCreateAgent(def, {
            ...opts,
            // Env-derived overrides win over anything spread from opts.
            mcpServers: mergedMcpServers,
            providerEnv: env.providerEnv,
            defaultDisallowedTools: env.defaults?.disallowedTools,
            // `hooks` is opaque `unknown` on the generic CreateOptions; CAS
            // treats it as its structural `SdkHooks` pass-through to Options.
            hooks: opts.hooks as SdkHooks | undefined,
            ...(env.transport ? { transport: env.transport } : {}),
        });
    };

    const listModels = async (): Promise<ModelInfo[]> => {
        // CAS doesn't expose a model discovery API; the caller knows
        // their own model lineup. Returning an empty array is the
        // honest answer — frontends fall back to a static list.
        return [];
    };

    const identify = async (): Promise<{
        authed: boolean;
        principal?: string;
    }> => {
        // Probe whether *some* provider creds are wired. The lib has no
        // way to validate them; presence is the best we can do.
        const authed =
            Boolean(env.providerEnv && Object.keys(env.providerEnv).length > 0) ||
            Boolean(process.env.ANTHROPIC_API_KEY);
        return { authed };
    };

    return {
        capabilities,
        createAgent,
        listModels,
        identify,
    };
}

