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
import type { RenderEntry } from '../route/render';

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
    /**
     * Optional auto-dispatch trigger. Workflows without a trigger run
     * only when explicitly dispatched (via the agent's `execute`, the
     * Slack subscriber, `_platform://task`, etc.). Workflows *with* a
     * trigger run on the trigger's schedule — these are the "static"
     * workflows the user identified: extractions, periodic refreshes,
     * scheduled audits, anything that historically had its own worker
     * loop.
     *
     * Per the unification: an extraction is just a workflow with
     * `trigger: { cron: ... }` + a `route` step that calls an
     * `extract://<source>` route + a `brain://write` step that lands
     * the result under `workspaces/<w>/extracted/`. The legacy
     * `defineExtraction` + extraction-worker pair retires when every
     * plugin migrates.
     */
    trigger?: WorkflowTrigger;
}

export interface WorkflowTrigger {
    /** Standard 5-field cron expression. UTC. Set to `null`/absent to
     *  disable auto-dispatch (workflow stays on-demand). */
    cron?: string;
    /** Optional invariant inputs the scheduler always passes — kept
     *  here rather than inline in `steps` so the trigger row is the
     *  single source of truth for the auto-dispatched shape. */
    inputs?: Record<string, unknown>;
}

// ─── Step kinds ────────────────────────────────────────────────────────────

export type WorkflowStep =
    | RouteStep
    | InputStep
    | AgentStep
    | SubworkflowStep
    | ParallelStep;

export type StepKind =
    | 'route'
    | 'input'
    | 'agent'
    | 'subworkflow'
    | 'parallel';

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
    /**
     * Render projection for the step's output.
     *
     * **Manifest form** (`RenderEntry[]`) — full per-step projection.
     * The walker attaches this to step output as `render: [...]` and
     * `projectStepOutput` walks it to emit `fact.component` events.
     * Use this when the route doesn't have its own manifest (generic
     * SQL runners, ad-hoc routes) or when a workflow author wants a
     * tailored view of the data.
     *
     * **String form** (legacy coarse hint) — a single rendering kind
     * preserved for back-compat. Subscribers MAY honor it via their
     * own heuristics; the walker treats it as a no-op.
     */
    render?:
        | 'chart' | 'table' | 'value' | 'markdown' | 'json' | 'none'
        | ReadonlyArray<RenderEntry>;
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
 * Runtime backend that executes an agent step. The choice belongs to
 * the agent declaration (`AgentDeclaration.harness`), not to the step
 * kind — every agent step is `kind: 'agent'`. Defaults to `'cas'`.
 */
export type AgentHarness = 'cas' | 'cursor' | 'fragua-pi';

/**
 * Single agent step. Two forms:
 *
 * **Reference form (common case).** `ref:` names a managed-agent /
 * workflow slug; the runtime resolves it through the workflow reader
 * and merges in any per-call overrides (`prompt`, `inputs`, `harness`,
 * `model`, etc.). Authoring stays DRY — the agent's identity lives in
 * one MD file, call sites supply only what varies.
 *
 * **Inline form (escape hatch).** Omit `ref:` and provide `model` +
 * `systemPrompt` + `prompt` directly. Useful for one-off agents that
 * don't deserve their own declaration. `harness:` defaults to `'cas'`.
 *
 * `providerOverride` is only meaningful when the resolved harness is
 * `'fragua-pi'`; validate.ts rejects it elsewhere.
 */
export interface AgentStep extends BaseStep {
    kind: 'agent';
    /** Managed-agent / workflow slug to resolve. */
    ref?: string;
    /** Inputs passed to the resolved workflow (or ignored for inline). */
    inputs?: Record<string, unknown>;
    /** Per-call harness override (rarely needed when `ref` is set). */
    harness?: AgentHarness;
    /** Per-call model override; required in inline form. */
    model?: string;
    /** Required in inline form; optional override in ref form. */
    systemPrompt?: SystemPromptConfig;
    maxTurns?: number;
    mcpServers?: string[];
    /** Built-in tool allow-list; absent/empty ⇒ harness default. */
    tools?: string[];
    /** Built-in tool deny-list; complements `tools`. */
    disallowedTools?: string[];
    /** Optional structured output schema. */
    outputFormat?: JsonSchemaOutputFormat;
    /** User-turn prompt body; supports `{{ }}` string templating. */
    prompt?: string;
    /** Callable child workflows exposed to the LLM via the Task tool. */
    subagents?: Record<string, { ref: string }>;
    /** Only valid when resolved harness is `'fragua-pi'`. */
    providerOverride?: 'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter';
}

/** Type guard: narrow a `WorkflowStep` to an agent step. */
export function isAgentStep(step: WorkflowStep): step is AgentStep {
    return step.kind === 'agent';
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

/**
 * Scatter-gather: dispatch every entry in `branches` concurrently
 * through the same step-kind registry. The step's output is a record
 * `{ [branchKey]: <branchOutput>, ... }` — readable downstream via
 * `{ from: <parallelStepId> }.<branchKey>`.
 *
 * Branches may be any deterministic step kind (route, agent,
 * subworkflow, nested parallel). `input` steps are rejected at
 * dispatch time — HITL pauses belong at the workflow level so one
 * branch can't strand its siblings mid-flight.
 *
 * First branch failure surfaces as the parallel step's error; sibling
 * branches finish on their own (no cross-cancellation in v1). Routes
 * are cheap so this is rarely material; if it becomes one, layer an
 * abort-on-error controller later without changing this contract.
 */
export interface ParallelStep extends BaseStep {
    kind: 'parallel';
    branches: Record<string, WorkflowStep>;
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
