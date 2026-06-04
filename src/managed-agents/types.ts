/**
 * Managed-agents type surface (§7).
 *
 * Pure data — no I/O, no SDK dependency, no transport binding. The
 * in-process transport wraps `CompiledAgent` into Anthropic SDK
 * `Options`; the laptop transport dispatches the same shape through
 * HTTP; the mcp transport (a remote MCP client) reads it the same way.
 *
 * The §7.1 split between *declaration* and *invocation* lives here; the
 * §7.2 `AgentContext` is the single threaded value every dispatcher
 * passes through.
 */

/**
 * System prompt shape — either a raw string (use as-is) or a preset
 * (the SDK's `claude_code` preset, with an optional `append` body).
 */
export type SystemPromptConfig =
    | string
    | { type: 'preset'; preset: 'claude_code'; append?: string };

/**
 * Self-contained JSON Schema for structured output. Mirrors the
 * Anthropic SDK's `JsonSchemaOutputFormat` structurally; redeclared
 * here so the lib stays SDK-agnostic. Schemas must be self-contained
 * (no unresolved `$ref`s) by the time they reach the SDK — §7.6's
 * composer inlines refs before the wrapper hands off.
 */
export interface JsonSchemaOutputFormat {
    type: 'json_schema';
    name?: string;
    schema: Record<string, unknown>;
}

/**
 * Static description of an agent. The host application's workflow
 * config structurally satisfies this today; the same shape
 * `managed-agents/<slug>.md` frontmatter parses to when §7 stop 6
 * lands. Pure data — no runtime.
 *
 * `mcpServers` is `string[]` rather than a strict id type
 * because the registry of legal ids lives in the host application,
 * not in this lib. The host's own workflow config uses the stricter
 * id-typed shape; lib accepts anything structurally and trusts the
 * caller to have type-checked.
 */
export interface AgentDeclaration {
    id: string;
    name: string;
    description: string;
    /**
     * Runtime backend. Defaults to `'cas'` when absent. The legacy
     * `provider` field (ANTHROPIC | OPEN_ROUTER) maps to harness at
     * compile time: ANTHROPIC → cas, OPEN_ROUTER → fragua-pi (the
     * multi-provider harness). Authors writing new agents should set
     * `harness:` directly.
     */
    harness?: 'cas' | 'cursor' | 'fragua-pi' | 'remote-vm';
    provider?: 'ANTHROPIC' | 'OPEN_ROUTER';
    model: string;
    systemPrompt: SystemPromptConfig;
    maxTurns: number;
    mcpServers: string[];
    outputFormat?: JsonSchemaOutputFormat;
    disallowedTools?: string[];
    /**
     * Managed-agents §7.4 — declared scope set the agent runs with.
     * At dispatch the runtime narrows to `caller ∩ scope`; if `scope`
     * contains any scope the caller lacks, the call fails (the MD
     * cannot escalate beyond what the caller could authorize).
     * Absent ≡ inherit caller scopes unchanged (legacy TS workflows).
     */
    scope?: string[];
    /**
     * Child workflows exposed to the agent via the Task tool. Each
     * entry's `ref` resolves through the workflow reader at dispatch
     * time. Frontmatter shape: `subagents: { <slug>: { ref:
     * <workflow-name> } }` — same as `AgentStep.subagents`.
     */
    subagents?: Record<string, { ref: string }>;
    /**
     * Managed-agents §7.12 — opt-in tags. `'subagent'` permits invocation
     * via the `_platform://task` route. Default (absent) means the agent
     * is NOT callable as a subagent — workspaces curate their public menu,
     * cron-only agents stay off it.
     */
    callableAs?: string[];
}

/**
 * The runtime surface the dispatcher is running on (the transport).
 * Threaded through to `compileAgent` so the per-surface
 * `_platform/<surface>.md` body is appended on top of the universal
 * `_platform/WORKSPACE.md`. Absent ≡ skip the per-surface append
 * (legacy callers, tests, scripts without a workdir).
 *
 * - `A` — the in-process transport (runs in the host process: chat
 *   backend, cron, managed-agent runtime).
 * - `B` — the mcp transport (a remote MCP client).
 * - `C` — the laptop transport (a dev laptop with a synced checkout +
 *   plugin).
 */
export type TierId = 'A' | 'B' | 'C';

/**
 * The single threaded value every dispatcher (chat adapter, cron
 * scheduler, HTTP route, spawn-workflow script, the laptop transport)
 * hands to `compileAgent` / `invokeAgent`. §7.2.
 *
 * Kept narrow on day one — `session.cwd` is the only field
 * `compileAgent` reads. Future stops widen: §7.3 needs
 * `session.workspaceName` for L3 layering; §7.5 adds `config` and
 * `platform` namespaces for the template resolver; §7.12 adds
 * `subagentDepth` for the depth cap.
 */
export interface AgentContext {
    session: {
        id: string;
        cwd?: string;
    };
    /**
     * Which transport (runtime surface) is composing this agent. Drives
     * the per-surface `_platform/<surface>.md` append. Optional for
     * backwards compatibility — callers that haven't migrated still get
     * the universal body only.
     */
    tier?: TierId;
}

/**
 * Result of `compileAgent`. Transport-agnostic — the per-transport
 * frontend finishes the binding:
 *
 * - the in-process transport: wraps to Anthropic SDK `Options` (`env`,
 *   `hooks`, `abortController`, `cwd`, `persistSession`, `resume`,
 *   `forkSession`, `mcpServers` connection record).
 * - the laptop transport: forwards through HTTP to the in-process
 *   transport.
 * - the mcp transport: same wrapping, different transport.
 */
export interface CompiledAgent {
    model: string;
    systemPrompt: SystemPromptConfig;
    maxTurns: number;
    mcpServers: string[];
    outputFormat?: JsonSchemaOutputFormat;
    disallowedTools?: string[];
}
