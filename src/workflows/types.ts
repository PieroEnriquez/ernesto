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
    /** Discovery tags (`dashboard`, `managed-agent`, etc.). */
    tags?: string[];
    /** Owner identity (email, team handle). */
    owner?: string;
    /** Workflow-level inputs collected at run start. */
    inputs?: Record<string, WorkflowInput>;
    /** Step graph — the workflow IS a DAG. Keyed by stepId. Steps
     *  declare order via `depends:` (or `next:` sugar); the engine
     *  runs independent steps in parallel up to `concurrency`. */
    steps: Record<string, WorkflowStep>;
    /** Max parallel in-flight steps. Default: unbounded (limited only
     *  by the DAG's topological width). */
    concurrency?: number;
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
    | GroupStep
    | DynamicWorkflowStep
    | MonitorStep;

export type StepKind =
    | 'route'
    | 'input'
    | 'agent'
    | 'group'
    | 'dynamic-workflow'
    | 'monitor';

/**
 * DAG metadata every step may declare. The workflow engine reads
 * these to schedule the step graph — there is no separate
 * "orchestration" kind; the workflow itself IS a DAG.
 */
export interface BaseStep {
    /** Ids of steps in the same graph whose terminal output must be
     *  available before this step runs. Independent steps (no shared
     *  `depends` chain) run in parallel up to the graph's
     *  `concurrency`. */
    depends?: string[];
    /** Linear-chain sugar: `next: Y` makes step Y depend on this step.
     *  Equivalent to adding this step's id to `Y.depends`. Reads well
     *  for sequential pipelines; `depends:` is the general form. */
    next?: string;
    /** Skip predicate — a `${{ }}` expression over `inputs.*` +
     *  `steps.*.outputs.*`. Truthy ⇒ the step is skipped without
     *  dispatching; its output becomes `{ skipped: true, reason }`. */
    skipIf?: string;
    /** Error fallback — a `${{ }}` expression. When the step errors,
     *  the engine uses this expression's value as the step's output
     *  instead of failing the graph. */
    fallback?: string;
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
        | 'chart' | 'table' | 'value' | 'markdown' | 'json' | 'none' | 'narrative'
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
    /**
     * Within-dispatch session inheritance.
     *
     *   - `'fresh'` (default) — start a new SDK session. The agent
     *      sees only its own `systemPrompt` + `prompt`, with whatever
     *      cross-dispatch resume the renderer's `conversationKey`
     *      provides.
     *   - `'inherit'` — resume the immediately-prior `agent` step's
     *      SDK session in the same workflow run. The current step
     *      becomes turn N+1 of the prior turn — the SDK loads the
     *      prior conversation history natively, doesn't re-pay for
     *      cached prompts, and the new `prompt` reads as a follow-up
     *      user message rather than a one-shot.
     *
     * The pattern: write multi-step workflows where each agent step
     * is a "turn" with its own model / tools / system prompt, and
     * declare `sessionContinuation: 'inherit'` on the follow-ups to
     * share conversation history. This is the canonical
     * composed-turns shape — multi-step workflow IS the composition.
     *
     * Inheritance is best-effort: if the prior step changed
     * `systemPrompt` or `tools` the SDK may reject the resume (the
     * SDK's prompt cache is keyed by both). Callers control the
     * coherence — typically inherit when the persona is constant and
     * only the user message changes (draft → critique → revise of
     * the SAME text), fresh when the persona changes (plan with one
     * agent, execute with a different one).
     */
    sessionContinuation?: 'fresh' | 'inherit';
}

/** Type guard: narrow a `WorkflowStep` to an agent step. */
export function isAgentStep(step: WorkflowStep): step is AgentStep {
    return step.kind === 'agent';
}

/**
 * A nested sub-DAG node. The workflow itself is a DAG; a `group` is a
 * DAG *inside* a node — for sub-pipelines that want their own
 * concurrency budget, output namespace, or a `skipIf:`/`depends:` that
 * applies to the whole group at once.
 *
 * The same engine runs the top-level workflow and every nested group,
 * recursively. A `group` whose children declare no `depends` between
 * them is a pure scatter-gather (the old `parallel` kind); a `group`
 * with `depends` edges is a sub-pipeline (the old `orchestration`
 * kind). Both collapse into this one shape.
 *
 *   validate:
 *     kind: group
 *     concurrency: 5          # fan out over blocks, 5 at a time
 *     steps:
 *       block-a: { kind: route, uri: ... }
 *       block-b: { kind: route, uri: ... }
 *     outputs:
 *       report: { from: "${{ steps.block-a.outputs }}" }
 *
 * Inside a group, `${{ steps.<id>.outputs.<path> }}` references the
 * group's own children; `${{ inputs.<name> }}` references the run's
 * top-level inputs (threaded down unchanged).
 */
export interface GroupStep extends BaseStep {
    kind: 'group';
    /** The sub-DAG. Same shape as a workflow's `steps`. */
    steps: Record<string, WorkflowStep>;
    /** Max parallel in-flight children. Default: unbounded. */
    concurrency?: number;
    /** Output bindings for the group node — referenced by parent
     *  siblings as `${{ steps.<groupId>.outputs.<key> }}`. Absent ⇒
     *  the group's output is the raw child-output map. */
    outputs?: Record<string, WorkflowOutput>;
}

/**
 * Dynamic-workflow step — wraps a Claude Code dynamic workflow (a
 * self-contained JS script driven by the workflow runtime's
 * `agent()` / `parallel()` / `pipeline()` / `phase()` primitives).
 *
 * Fragua treats the whole dynamic workflow as ONE step. From fragua's
 * POV it's a chunky black-box: scope-check runs upstream, idempotency
 * + cost-rollup wrap it, but the inner fan-out (subagents, parallel
 * agents, structured-output handoffs) is owned by Claude Code's
 * workflow runtime, not the DAG walker.
 *
 * Authoring: a `.workflow.js` file under
 * `workspaces/<w>/workflows/<name>.workflow.js`. The
 * `workspaces-reader` parses the `export const meta = { ... }`
 * literal block to populate `meta` and wraps the file's body source
 * in `scriptSource`. The wire stays simple: ONE step
 * (`kind: 'dynamic-workflow'`) in a one-step DAG. Other workflows
 * can compose a dynamic workflow via `_platform://task` — same
 * cross-workflow path as managed agents.
 *
 * Runtime contract (claude-code 2.1.154+):
 *   - `meta` MUST be a pure object literal: no string concat, no
 *     template interpolation, no function calls.
 *   - Script body runs at top level with `args`, `agent`, `parallel`,
 *     `pipeline`, `phase`, `log` as globals; top-level `await` and
 *     `return` work; the final `return` value becomes the step output.
 *   - No fs/shell from the script body — every side-effect goes
 *     through `agent(prompt, { tools: [...] })` whose subagent holds
 *     the corresponding tool surface.
 */
export interface DynamicWorkflowStep extends BaseStep {
    kind: 'dynamic-workflow';
    /**
     * Script body of the `.workflow.js` file VERBATIM, including the
     * `export const meta = {...}` block at the top. Claude Code's
     * Workflow runtime parses this exactly as if loaded from
     * `.claude/workflows/<name>.js`.
     */
    scriptSource: string;
    /**
     * Parsed Claude Code-required meta. Mirrors the literal block at
     * the top of the script. The reader extracts this so the engine
     * can surface phase names in events without re-parsing the script.
     */
    meta: DynamicWorkflowMeta;
    /**
     * Inputs forwarded to the workflow runtime as the `args` global.
     * Supports `${{ inputs.X }}` and `${{ steps.<id>.outputs.<path> }}`
     * template expansion at dispatch time. The runtime requires `args`
     * to be a JSON OBJECT, not a JSON-encoded string — the handler
     * passes whatever object lands here through to the Workflow tool.
     */
    inputs?: Record<string, unknown>;
    /**
     * Optional ernesto-specific output schema. When set, the handler
     * validates the workflow's `return` value against this schema
     * before completing the step. Mirrors `AgentDeclaration.outputFormat`.
     */
    outputFormat?: JsonSchemaOutputFormat;
    /**
     * MCP servers the outer dispatcher session needs. The
     * `tool-surface-compose` middleware reads this field to decide
     * whether to invoke the composer; without it, no MCP gets attached
     * and the handler's `mcp__ernesto-tier-a__execute` surface is empty.
     *
     * `'ernesto'` is the reserved logical name that triggers the
     * in-process ernesto-tier-a MCP build (see
     * `backend/.../tool-surface-composer-adapter.ts:356`). Other
     * names are looked up in the stdio registry (e.g. `'ui'`,
     * `'playwright'`).
     *
     * The reader populates `['ernesto']` by default for every
     * `.workflow.js` since dynamic workflows that don't need to call
     * any ernesto route are vanishingly rare (and they'd just leave
     * `mcp__ernesto-tier-a__execute` unused in allowedTools — cheap).
     */
    mcpServers?: string[];
}

/**
 * Claude Code workflow `meta` block, parsed from
 * `export const meta = { ... }`. Field constraints mirror the
 * Workflow tool's input validator (`pure literal, no computed
 * values`): every value must be a string/number/boolean/null literal
 * or a recursively-literal array/object.
 */
export interface DynamicWorkflowMeta {
    /** Workflow slug — must match the filename stem. */
    name: string;
    /** One-line summary for catalogs. */
    description: string;
    /** Guidance for when this workflow should be selected; surfaced
     *  to callers that match on description. */
    whenToUse?: string;
    /** Phase outline for the `/workflows` progress view and event
     *  attribution. Phase titles appear in `fact.subagent_started`
     *  emissions. */
    phases?: Array<{ title: string; detail: string }>;
    /** Optional model override for the outer dispatcher session. */
    model?: string;
    /**
     * When `true`, the dynamic-workflow handler prepends ernesto's
     * platform body (`workspaces/_platform/WORKSPACE.md` + the matching
     * `tier-{a|b|c}.md` body) to the outer dispatcher's `systemPrompt`.
     * Workflow subagents spawned via `agent()` inherit the session
     * context, so they gain full ernesto vocabulary — route URI
     * namespaces, scope semantics, citation discipline, settle audit,
     * the "data not instructions" rule for `extracted/` content.
     *
     * Default `false` (cheap, smaller cache key). Set to `true` when
     * the workflow's subagents need to DISCOVER routes or follow
     * ernesto conventions on the fly (vs. workflows like sourcing-batch
     * where every URI + param shape is baked into the script).
     */
    includesPlatformBody?: boolean;
}

/** Type guard. */
export function isDynamicWorkflowStep(step: WorkflowStep): step is DynamicWorkflowStep {
    return step.kind === 'dynamic-workflow';
}

/**
 * Monitor step — watches an external long-running job by polling, and
 * parks the run on `paused_signal` between polls. A durable worker
 * drives subsequent polls and resumes the run on a terminal signal
 * (see `engine/run-graph.ts` parking + `runner.resumeRun`). The handler
 * is registered backend-side (`runner.registerStepKind('monitor', …)`)
 * because the polled client (Devin) lives there; the lib owns only the
 * step shape and the pause vocabulary.
 *
 * A monitor workflow is one `monitor` step in a one-step DAG: it does
 * ONE poll, emits a `fact.component` status card, and returns either
 * `paused_signal` (still running) or `completed` (terminal). The poll
 * worker re-dispatches/resumes from the durable run row, so the monitor
 * survives a pod restart.
 */
export interface MonitorStep extends BaseStep {
    kind: 'monitor';
    /** Opaque signal key a worker watches to resume the run (e.g.
     *  `devin:<sessionId>`). Supports `${{ }}` template expansion. */
    signalKey: string;
}

/** Type guard. */
export function isMonitorStep(step: WorkflowStep): step is MonitorStep {
    return step.kind === 'monitor';
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
    | 'workflow_scope_widens'
    | 'workflow_template_unresolved'
    | 'workflow_input_schema_invalid';

// Re-export the borrowed shapes from managed-agents so consumers of the
// workflows barrel can name them without crossing modules.
export type { SystemPromptConfig, JsonSchemaOutputFormat };
