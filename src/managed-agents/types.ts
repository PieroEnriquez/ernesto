/**
 * Managed-agents type surface (§7).
 *
 * Pure data — no I/O, no SDK dependency, no transport binding. Backend
 * Tier-A wraps `CompiledAgent` into Anthropic SDK `Options`; Tier-C
 * laptop dispatches the same shape through HTTP; future Tier-B
 * (claude.ai integration) reads it the same way.
 *
 * Spec: `backend/src/ernesto/domains/workspaces/README.md` §7 (Managed
 * Agents). The §7.1 split between *declaration* and *invocation* lives
 * here; the §7.2 `AgentContext` is the single threaded value every
 * dispatcher passes through.
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
 * Static description of an agent. Backend's `WorkflowConfig`
 * structurally satisfies this today; the same shape `managed-agents/<slug>.md`
 * frontmatter parses to when §7 stop 6 lands. Pure data — no runtime.
 *
 * `mcpServers` is `string[]` rather than a strict id type
 * because the registry of legal ids lives on the *backend* side
 * (`MCP_SERVER_REGISTRY` in `backend/src/ernesto/server/http/mcp-servers.ts`).
 * The backend's own `WorkflowConfig.mcpServers: McpServerId[]` is the
 * stricter shape; lib accepts anything structurally and trusts the
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
    harness?: 'cas' | 'cursor' | 'fragua-pi';
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
     * Managed-agents §7.12 — opt-in tags. `'subagent'` permits invocation
     * via the `_platform://task` route. Default (absent) means the agent
     * is NOT callable as a subagent — workspaces curate their public menu,
     * cron-only agents stay off it.
     */
    callableAs?: string[];
}

/**
 * Tier the dispatcher is running on. Threaded through to `compileAgent`
 * so the per-tier `_platform/tier-{a|b|c}.md` body is appended on top
 * of the universal `_platform/WORKSPACE.md`. Absent ≡ skip the tier
 * append (legacy callers, tests, scripts without a workdir).
 *
 * - `A` — server-side (Slack backend, cron, managed-agent runtime).
 * - `B` — claude.ai MCP integration.
 * - `C` — laptop CLI / Claude Code `/ernesto` skill.
 */
export type TierId = 'A' | 'B' | 'C';

/**
 * The single threaded value every dispatcher (Slack adapter, cron
 * scheduler, HTTP route, spawn-workflow script, Tier-C CLI) hands to
 * `compileAgent` / `invokeAgent`. §7.2.
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
     * Which tier frontend is composing this agent. Drives the
     * `_platform/tier-{a|b|c}.md` append. Optional for backwards
     * compatibility — callers that haven't migrated still get the
     * universal body only.
     */
    tier?: TierId;
}

/**
 * Result of `compileAgent`. Transport-agnostic — the per-tier
 * frontend finishes the binding:
 *
 * - Backend Tier-A: wraps to Anthropic SDK `Options` (`env`, `hooks`,
 *   `abortController`, `cwd`, `persistSession`, `resume`,
 *   `forkSession`, `mcpServers` connection record).
 * - Tier-C laptop: forwards through HTTP to backend Tier-A.
 * - Future Tier-B: same wrapping, different transport.
 */
export interface CompiledAgent {
    model: string;
    systemPrompt: SystemPromptConfig;
    maxTurns: number;
    mcpServers: string[];
    outputFormat?: JsonSchemaOutputFormat;
    disallowedTools?: string[];
}
