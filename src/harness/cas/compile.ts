/**
 * `CompiledAgent` → CAS SDK `Options` compiler.
 *
 * Source of truth for the SDK shape:
 *   `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
 *     - `Options`
 *     - `SystemPromptPreset` (claude_code preset + `excludeDynamicSections`)
 *     - `McpServerConfig`
 *
 * Ported from the host application's own SDK-options builder. The
 * host-specific bits stay in the host wrapper:
 *   - provider resolution — host-private. Pass `providerEnv` in if you
 *     need it.
 *   - sandbox hooks — host-private. Compose into the returned
 *     `Options.hooks` post-call.
 *   - the cache-discipline `log.info` probe — host-only observability.
 *
 * Cache-discipline knobs preserved verbatim:
 *   - `systemPrompt.excludeDynamicSections = true` on the preset branch
 *     (strip per-run dynamic sections, see SDK sdk.d.ts).
 *   - `settingSources = []` (SDK isolation mode — do not auto-load
 *     `cwd/CLAUDE.md`; the platform body comes through `compileAgent`).
 *   - `includePartialMessages = true` (stream `stream_event` partials
 *     so long generations don't trip inactivity watchdogs).
 */

import type { Options, McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { CompiledAgent } from '../../managed-agents/types';

/** Opaque hook shape — the lib treats `hooks` as an opaque pass-through
 *  to `Options.hooks`. We don't nominally type against the SDK's
 *  `HookEvent` enum because consumers may resolve a different SDK
 *  version through pnpm's peer-dep tree (the SDK's nominal types from
 *  two different versions don't unify, even when structurally
 *  identical). A loose record keeps the boundary structural; the SDK
 *  validates at runtime. */
export type SdkHooks = Record<string, unknown>;

/** Compile context. The host wrapper resolves provider env / sandbox
 *  hooks itself and threads what it needs through here. */
export interface CompileContext {
    /** The Agent SDK's conversation transcript id (its `session_id`).
     *  Threaded for provider-cache identity. */
    transcriptId: string;
    cwd?: string;
    abortController?: AbortController;
    /** Pre-resolved MCP server connection record. Host-private
     *  registry; we accept the resolved shape. */
    mcpServers?: Record<string, McpServerConfig>;
    /** Provider-resolved env vars (api key + base url). Provider
     *  resolution stays in the host application; the lib takes the
     *  already-resolved record. */
    providerEnv?: Record<string, string>;
    /** Additional env merged on top of providerEnv. */
    env?: Record<string, string>;
    /** Persist the Agent SDK's conversation transcript (its
     *  `session_id`). Maps to the SDK's `persistSession` option. */
    persistTranscript?: boolean;
    /** Resume a prior transcript (the Agent SDK's `session_id`). Maps
     *  to the SDK's `resume` option. */
    resumeTranscript?: string;
    /** Fork from `resumeTranscript`. Maps to the SDK's `forkSession`
     *  option. */
    forkTranscript?: boolean;
    /** Built-in tool whitelist (the SDK's `tools` option). */
    tools?: string[];
    /** Default disallowed-tools list applied when `compiled.disallowedTools`
     *  is absent. Note: `compileAgent` already merges its own
     *  `defaults.disallowedTools`; this is the harness-level fallback. */
    defaultDisallowedTools?: string[];
    /** Host-resolved sandbox hooks (e.g. workspace-anchored
     *  Read/Edit/Write guard). The lib treats this as opaque and
     *  passes it through to `Options.hooks`. Host wrappers compose
     *  these themselves; the lib does not synthesize hooks. */
    hooks?: SdkHooks;
}

/**
 * Compile a transport-agnostic `CompiledAgent` into Anthropic SDK
 * `Options`. Behavior must remain byte-equivalent to the legacy
 * `workflowToSdkOptions` for the fields the SDK actually consumes.
 */
export function compileAgentToSdkOptions(compiled: CompiledAgent, ctx: CompileContext): Options {
    const baseEnv: Record<string, string> = {
        ...(ctx.providerEnv ?? {}),
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        // Safety net for SDK CLI subprocess inactivity.
        CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '120000',
    };

    // Cache-fix: strip the SDK's per-run dynamic sections (cwd,
    // auto-memory, git status) from the cached system prompt when the
    // preset branch is in use. Source: sdk.d.ts ~line 1755.
    const systemPromptForSdk = withExcludeDynamicSections(compiled.systemPrompt);

    const disallowedTools = compiled.disallowedTools ?? ctx.defaultDisallowedTools;

    return {
        model: compiled.model,
        systemPrompt: systemPromptForSdk,
        maxTurns: compiled.maxTurns,
        mcpServers: ctx.mcpServers,
        outputFormat: compiled.outputFormat,
        permissionMode: 'bypassPermissions',
        disallowedTools,
        includePartialMessages: true,
        ...(ctx.tools ? { tools: ctx.tools } : {}),
        // SDK isolation — do not auto-load `cwd/CLAUDE.md`. The
        // platform body is composed through `compileAgent` and lives in
        // `systemPrompt`. (Isolation here is the SDK setting-load mode,
        // independent of vm/sandbox isolation.)
        settingSources: [],
        // `ctx.hooks` is intentionally structural — see `SdkHooks`
        // commentary. The SDK validates the nominal shape at runtime.
        hooks: ctx.hooks as Options['hooks'],
        abortController: ctx.abortController,
        cwd: ctx.cwd,
        // SDK option names (`persistSession`/`resume`/`forkSession`) are
        // fixed by the Agent SDK; we map our transcript-named fields onto them.
        persistSession: ctx.persistTranscript,
        resume: ctx.resumeTranscript,
        forkSession: ctx.forkTranscript,
        env: ctx.env ? { ...ctx.env, ...baseEnv } : baseEnv,
    };
}

/**
 * Branchy widen-then-narrow: the preset variant of `SystemPromptConfig`
 * passes through with `excludeDynamicSections: true` added; the raw
 * string variant is returned unchanged.
 *
 * The cast to `Options['systemPrompt']` is documented because the SDK's
 * preset shape adds `excludeDynamicSections` only when it sees the
 * `type: 'preset'` discriminator — our lib type doesn't carry that
 * field, so a structural cast is necessary at the boundary.
 */
function withExcludeDynamicSections(systemPrompt: CompiledAgent['systemPrompt']): Options['systemPrompt'] {
    if (typeof systemPrompt === 'object' && systemPrompt !== null && 'type' in systemPrompt && systemPrompt.type === 'preset') {
        return {
            type: 'preset',
            preset: systemPrompt.preset,
            append: systemPrompt.append,
            excludeDynamicSections: true,
        } as Options['systemPrompt'];
    }
    return systemPrompt as Options['systemPrompt'];
}
