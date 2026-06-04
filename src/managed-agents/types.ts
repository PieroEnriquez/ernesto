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
 *
 * This lib is the canonical owner of the `Transport` / `Isolation`
 * vocabulary; the backend imports these names from here.
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
 * How a run reaches the backend — the transport it is composing on.
 * Threaded through to `compileAgent` so the per-transport
 * `_platform/<transport>.md` body is appended on top of the universal
 * `_platform/WORKSPACE.md`. Absent ≡ skip the per-transport append
 * (legacy callers, tests, scripts without a workdir).
 *
 * - `in-process` — runs in the host process (chat backend, cron,
 *   managed-agent runtime).
 * - `mcp` — a remote MCP client.
 * - `laptop` — a dev laptop with a synced checkout + plugin.
 * - `vm` — an isolated microVM; shares the `in-process` settle
 *   substrate and the overlay treats it like `in-process`.
 */
export type Transport = 'in-process' | 'mcp' | 'laptop' | 'vm';

/** Execution boundary a run held — `none` (managed/in-process) or `vm`
 *  (isolated microVM). */
export type Isolation = 'none' | 'vm';

/**
 * The single threaded value every dispatcher (chat adapter, cron
 * scheduler, HTTP route, spawn-workflow script, the laptop transport)
 * hands to `compileAgent` / `invokeAgent`. §7.2.
 *
 * Kept narrow on day one — `cwd` is the only field `compileAgent`
 * reads. Future stops widen: §7.3 needs a `workspaceName` for L3
 * layering; §7.5 adds `config` and `platform` namespaces for the
 * template resolver; §7.12 adds `subagentDepth` for the depth cap.
 */
export interface AgentContext {
    /** The bound per-run workdir the agent reads its platform body
     *  from (`<cwd>/workspaces/_platform/...`). */
    cwd?: string;
    /**
     * Which transport is composing this agent. Drives the
     * per-transport `_platform/<transport>.md` append. Optional for
     * backwards compatibility — callers that haven't migrated still get
     * the universal body only.
     */
    transport?: Transport;
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
