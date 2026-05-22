/**
 * Workflows — unified declaration schema (§ unified-workflow).
 *
 * Pure data. Defines the YAML/JSON shape that subsumes both
 * managed-agents and dashboards. See
 * `workspaces/agent-ops/workflows-unification/schema.md` for the
 * canonical reference; the types below mirror that doc 1:1.
 *
 * All side-effecting concerns (route resolution, harness invocation,
 * subworkflow dispatch) live in downstream runtime layers — this
 * module is just the contract.
 */

import type {
    SystemPromptConfig,
    JsonSchemaOutputFormat,
} from '../managed-agents/types';

// ─── Top-level declaration ────────────────────────────────────────────────

export interface WorkflowDeclaration {
    /** Slug; must match the filename stem. */
    name: string;
    /** One-line summary for catalogs. */
    description: string;
    /** Schema version. Bump on incompatible changes. */
    version: 1;
    /** Invocation surfaces that may dispatch this workflow. */
    callableAs?: string[];
    /** Declared scope set; narrowed by §7.4 at dispatch. */
    scope?: string[];
    /** Tier restriction; default 'any'. */
    tier?: 'A' | 'B' | 'C' | 'any';
    /** Discovery tags (`dashboard`, `managed-agent`, etc.). */
    tags?: string[];
    /** Owner identity (email, team handle). */
    owner?: string;
    /** Workflow-level inputs collected at run start. */
    inputs?: Record<string, WorkflowInput>;
    /** Step graph. Keyed by stepId. */
    steps: Record<string, WorkflowStep>;
    /** What the workflow returns to its caller. */
    outputs?: Record<string, WorkflowOutput>;
}

// ─── Step kinds ────────────────────────────────────────────────────────────

export type WorkflowStep = RouteStep | InputStep | AgentStep | SubworkflowStep;

export type StepKind =
    | 'route'
    | 'input'
    | 'agent-cas'
    | 'agent-cursor'
    | 'agent-fragua-pi'
    | 'subworkflow';

export interface BaseStep {
    /** Default outgoing edge. `outputs` or `outputs.<name>` is the terminal sink. */
    next?: string;
    /** Conditional edges keyed by event name. */
    on?: Record<string, string>;
}

export interface RouteStep extends BaseStep {
    kind: 'route';
    /** Route URI; resolved through the ernesto route registry. */
    uri: string;
    /** Parameters; supports `${{ }}` template expansion. */
    params?: Record<string, unknown>;
    /** Render hint for the per-tier subscriber. */
    render?: 'chart' | 'table' | 'value' | 'markdown' | 'json' | 'none';
    timeoutMs?: number;
    retries?: number;
}

export interface InputStep extends BaseStep {
    kind: 'input';
    /** JSON Schema (or Zod-compatible subset) describing expected input. */
    schema: Record<string, unknown>;
    /** Prompt text shown to the user. */
    prompt: string;
    /** Optional pre-fill values; supports `${{ }}` template expansion. */
    defaults?: Record<string, unknown>;
    /** If true and defaults satisfy required fields, skip the pause. */
    skipIfProvided?: boolean;
    /** Optional give-up timeout. */
    timeout?: { afterMs: number; then: string };
}

/**
 * Fields common to every agent step variant. The runtime harness is
 * encoded in the `kind` discriminator on the concrete subtype — not in
 * a separate `harness` field.
 */
export interface AgentBaseStep extends BaseStep {
    /** Opaque per-harness model identifier. */
    model: string;
    /** Re-uses managed-agents' `SystemPromptConfig` (string or preset). */
    systemPrompt: SystemPromptConfig;
    maxTurns?: number;
    mcpServers?: string[];
    /** Built-in tool allow-list; absent/empty ⇒ harness default. */
    tools?: string[];
    /** Built-in tool deny-list; complements `tools`. */
    disallowedTools?: string[];
    /** Optional structured output schema. */
    outputFormat?: JsonSchemaOutputFormat;
    /** User-turn prompt body; supports `{{ }}` string templating. */
    prompt: string;
    /** Callable child workflows exposed to the LLM via the Task tool. */
    subagents?: Record<string, { ref: string }>;
}

export interface AgentCasStep extends AgentBaseStep {
    kind: 'agent-cas';
}

export interface AgentCursorStep extends AgentBaseStep {
    kind: 'agent-cursor';
}

export interface AgentFraguaPiStep extends AgentBaseStep {
    kind: 'agent-fragua-pi';
    /** Override the harness env's default provider for this specific step. */
    providerOverride?: 'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter';
}

export type AgentStep = AgentCasStep | AgentCursorStep | AgentFraguaPiStep;

/** Type guard: narrow a `WorkflowStep` to the agent-step union. */
export function isAgentStep(step: WorkflowStep): step is AgentStep {
    return (
        step.kind === 'agent-cas' ||
        step.kind === 'agent-cursor' ||
        step.kind === 'agent-fragua-pi'
    );
}

export interface SubworkflowStep extends BaseStep {
    kind: 'subworkflow';
    /** Workspace-relative path OR registered slug. */
    ref: string;
    /** Inputs to pass; supports `${{ }}` template expansion. */
    inputs?: Record<string, unknown>;
    /** Optional further-narrowing scope. */
    scope?: string[];
}

// ─── Inputs & outputs ─────────────────────────────────────────────────────

export interface WorkflowInput {
    type: 'string' | 'number' | 'boolean' | 'date_range' | 'object' | 'array';
    enum?: unknown[];
    default?: unknown;
    description?: string;
    /** For type:'object' — nested schema for sub-fields. */
    properties?: Record<string, WorkflowInput>;
    /** For type:'object' — required sub-field names. */
    required?: string[];
}

export interface WorkflowOutput {
    /** Source step id, or array of ids (for dashboard-shape aggregations). */
    from: string | string[];
    /** Optional dotted path into the source step's result. */
    pick?: string;
    /** Render hint for the workflow's overall output shape. */
    shape?: 'dashboard' | 'agent_result' | 'value';
}

// ─── Validation result envelope ────────────────────────────────────────────

export interface WorkflowValidationResult {
    ok: boolean;
    errors: WorkflowValidationError[];
}

export interface WorkflowValidationError {
    code: WorkflowLintCode;
    stepId?: string;
    field?: string;
    message: string;
}

/**
 * The canonical 10 lint codes — see schema.md § Lint rules.
 *
 * Implementations may emit additional rule codes beyond these (e.g.
 * structural shape errors detected during parse), but every rule
 * listed in schema.md must use the exact code name from this union.
 */
export type WorkflowLintCode =
    | 'workflow_name_mismatch'
    | 'workflow_step_unreachable'
    | 'workflow_step_dead_end'
    | 'workflow_unknown_kind'
    | 'workflow_unknown_route'
    | 'workflow_unknown_harness'
    | 'workflow_subworkflow_unknown'
    | 'workflow_scope_widens'
    | 'workflow_template_unresolved'
    | 'workflow_input_schema_invalid';

// Re-export the borrowed shapes from managed-agents so consumers of the
// workflows barrel can name them without crossing modules.
export type { SystemPromptConfig, JsonSchemaOutputFormat };
