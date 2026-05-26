/**
 * Semantic validation of a `WorkflowDeclaration`.
 *
 * Implements the 10 `workflow_*` lint rules from schema.md. Each rule
 * appends one or more errors to a flat list; no rule short-circuits the
 * others, so authors see every problem at once.
 *
 * Template resolution covers both `${{ ... }}` (eager) and `{{ ... }}`
 * (string). Valid template roots: `inputs.<name>`, `steps.<id>.output[.<path>]`,
 * and `context.<field>`.
 */

import type {
    WorkflowDeclaration,
    WorkflowStep,
    WorkflowValidationResult,
    WorkflowValidationError,
    WorkflowLintCode,
    AgentStep,
    RouteStep,
    InputStep,
} from './types';
import { isAgentStep } from './types';

export interface WorkflowValidateContext {
    /** URIs the route registry knows about. Validate skips the check if absent. */
    knownRoutes?: Set<string>;
    /** Harness ids ('cas', 'cursor', 'fragua-pi'). Skips check if absent. */
    knownHarnesses?: Set<string>;
    /** Slug registry for `subworkflow.ref` resolution. Skips check if absent. */
    knownWorkflows?: Set<string>;
    /** Filename used in error messages and for the `workflow_name_mismatch` check. */
    filename?: string;
    /** Workspace's declared scope set; used by `workflow_scope_widens`. */
    declaredWorkspaceScopes?: string[];
}

const KNOWN_STEP_KINDS = new Set([
    'route',
    'input',
    'agent',
    'group',
]);

export function validateWorkflow(
    decl: WorkflowDeclaration,
    ctx: WorkflowValidateContext = {},
): WorkflowValidationResult {
    const errors: WorkflowValidationError[] = [];

    checkNameMatchesFilename(decl, ctx, errors);
    checkSchemaShape(decl, ctx, errors);
    checkStepKindsKnown(decl, errors);
    checkDag(decl, errors);
    checkRoutes(decl, ctx, errors);
    checkHarnesses(decl, ctx, errors);
    checkScopeWidens(decl, ctx, errors);
    checkTemplateRefs(decl, errors);
    checkInputSchemas(decl, errors);

    return { ok: errors.length === 0, errors };
}

// ─── workflow_name_mismatch ──────────────────────────────────────────────

function checkNameMatchesFilename(
    decl: WorkflowDeclaration,
    ctx: WorkflowValidateContext,
    errors: WorkflowValidationError[],
): void {
    if (!ctx.filename) return;
    const stem = filenameStem(ctx.filename);
    if (stem === undefined) return;
    if (stem !== decl.name) {
        errors.push({
            code: 'workflow_name_mismatch',
            field: 'name',
            message: `workflow "name: ${decl.name}" does not match filename stem "${stem}"`,
        });
    }
}

function filenameStem(filename: string): string | undefined {
    const base = filename.replace(/^.*\//, '');
    // Workflow YAMLs: <slug>.yaml or <slug>.workflow.yaml
    // Managed-agent MDs: <slug>.md
    // Dashboard-shaped workflow YAMLs: <slug>.dashboard.yaml — the
    // `.dashboard` infix is a convention marker (also reflected in
    // `tags: [dashboard]` inside the file); the slug is everything
    // before that infix.
    const m = /^(.+?)(?:\.(?:workflow|dashboard))?\.(yaml|yml|md)$/.exec(base);
    return m?.[1];
}

// ─── workflow_unknown_kind ──────────────────────────────────────────────

function checkSchemaShape(
    decl: WorkflowDeclaration,
    _ctx: WorkflowValidateContext,
    errors: WorkflowValidationError[],
): void {
    if (decl.version !== 1) {
        errors.push({
            code: 'workflow_unknown_kind', // closest documented code
            field: 'version',
            message: `unsupported workflow version "${String(decl.version)}" (expected 1)`,
        });
    }
}

function checkStepKindsKnown(
    decl: WorkflowDeclaration,
    errors: WorkflowValidationError[],
): void {
    for (const [stepId, step] of Object.entries(decl.steps)) {
        if (!KNOWN_STEP_KINDS.has(step.kind)) {
            errors.push({
                code: 'workflow_unknown_kind',
                stepId,
                field: 'kind',
                message: `step "${stepId}" has unknown kind "${step.kind}" (expected one of ${[...KNOWN_STEP_KINDS].join(' | ')})`,
            });
        }
    }
}

// ─── DAG integrity: depends/next reference real steps; no cycles ────────
//
// The workflow IS a DAG. Settle-time lint catches the two structural
// faults run-graph would otherwise hit at dispatch: an edge
// (`depends:` or `next:`) pointing at a non-existent step, or a cycle.
// There is no "unreachable" or "dead-end" concept — every declared
// step runs (topologically), and a step with no dependents is a valid
// sink.

function checkDag(
    decl: WorkflowDeclaration,
    errors: WorkflowValidationError[],
): void {
    const stepIds = Object.keys(decl.steps);
    if (stepIds.length === 0) return;
    const ids = new Set(stepIds);

    // Normalize `next:` → depends edges, validating targets exist.
    const dependsOf = new Map<string, string[]>();
    for (const id of stepIds) dependsOf.set(id, [...(decl.steps[id]!.depends ?? [])]);
    for (const [id, step] of Object.entries(decl.steps)) {
        for (const dep of step.depends ?? []) {
            if (!ids.has(dep)) {
                errors.push({
                    code: 'workflow_step_unreachable',
                    stepId: id,
                    field: 'depends',
                    message: `step "${id}" depends on unknown step "${dep}"`,
                });
            } else if (dep === id) {
                errors.push({
                    code: 'workflow_step_unreachable',
                    stepId: id,
                    field: 'depends',
                    message: `step "${id}" depends on itself`,
                });
            }
        }
        if (step.next !== undefined) {
            if (!ids.has(step.next)) {
                errors.push({
                    code: 'workflow_step_unreachable',
                    stepId: id,
                    field: 'next',
                    message: `step "${id}" has next: "${step.next}" which is not a declared step`,
                });
            } else {
                dependsOf.get(step.next)!.push(id);
            }
        }
    }

    // Cycle detection (Kahn). Only run if all edges resolve.
    if (errors.some((e) => e.code === 'workflow_step_unreachable')) return;
    const inDegree = new Map<string, number>();
    for (const id of ids) inDegree.set(id, (dependsOf.get(id) ?? []).length);
    const adj = new Map<string, string[]>();
    for (const id of ids) adj.set(id, []);
    for (const [id, deps] of dependsOf) {
        for (const dep of deps) adj.get(dep)!.push(id);
    }
    const queue: string[] = [];
    for (const [id, d] of inDegree) if (d === 0) queue.push(id);
    let visited = 0;
    while (queue.length) {
        const id = queue.shift()!;
        visited++;
        for (const down of adj.get(id) ?? []) {
            const d = (inDegree.get(down) ?? 0) - 1;
            inDegree.set(down, d);
            if (d === 0) queue.push(down);
        }
    }
    if (visited !== ids.size) {
        errors.push({
            code: 'workflow_step_dead_end',
            stepId: stepIds[0]!,
            message: 'step graph has a cycle (depends/next form a loop)',
        });
    }
}

// ─── workflow_unknown_route ─────────────────────────────────────────────

function checkRoutes(
    decl: WorkflowDeclaration,
    ctx: WorkflowValidateContext,
    errors: WorkflowValidationError[],
): void {
    if (!ctx.knownRoutes) return;
    for (const [id, step] of Object.entries(decl.steps)) {
        if (step.kind !== 'route') continue;
        const uri = (step as RouteStep).uri;
        if (!ctx.knownRoutes.has(uri)) {
            errors.push({
                code: 'workflow_unknown_route',
                stepId: id,
                field: 'uri',
                message: `route step "${id}" references unknown route "${uri}"`,
            });
        }
    }
}

// ─── workflow_unknown_harness ───────────────────────────────────────────

/**
 * Hint-quality rule for the `agent` step kind's `harness:` field.
 * Fires only when `ctx.knownHarnesses` is provided AND the step pins
 * an explicit harness that's not in the registered set. Inline-form
 * agent steps without `harness:` fall back to `'cas'` at dispatch;
 * ref-form steps resolve harness from the referenced declaration —
 * neither is the parser's concern.
 */
function checkHarnesses(
    decl: WorkflowDeclaration,
    ctx: WorkflowValidateContext,
    errors: WorkflowValidationError[],
): void {
    if (!ctx.knownHarnesses) return;
    for (const [id, step] of Object.entries(decl.steps)) {
        if (step.kind !== 'agent') continue;
        const harness = (step as { harness?: string }).harness;
        if (!harness) continue;
        if (ctx.knownHarnesses.has(harness)) continue;
        const suggestion = closestHarness(harness, ctx.knownHarnesses);
        const hint = suggestion ? ` — did you mean ${suggestion}?` : '';
        errors.push({
            code: 'workflow_unknown_harness',
            stepId: id,
            field: 'harness',
            message: `agent step "${id}".harness "${harness}" is not in the registered set [${[...ctx.knownHarnesses].sort().join(', ')}]${hint}`,
        });
    }
}

function closestHarness(
    needle: string,
    haystack: ReadonlySet<string>,
): string | undefined {
    let best: { name: string; d: number } | undefined;
    for (const h of haystack) {
        const d = editDistance(needle, h);
        if (best === undefined || d < best.d) best = { name: h, d };
    }
    if (!best || best.d === 0) return undefined;
    // Always suggest the closest registered harness. The set is small
    // (handful of harnesses) — any nudge is more useful than none.
    return best.name;
}

function editDistance(a: string, b: string): number {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const prev = new Array<number>(n + 1);
    const curr = new Array<number>(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }
    return prev[n];
}

// ─── workflow_scope_widens ──────────────────────────────────────────────

function checkScopeWidens(
    decl: WorkflowDeclaration,
    ctx: WorkflowValidateContext,
    errors: WorkflowValidationError[],
): void {
    // The top-level workflow.scope shouldn't widen vs the workspace's
    // declared scopes. Step-level widening doesn't apply post-subworkflow-
    // removal — dispatches through `kind: route` to other workflows
    // narrow via the principal at runtime, not via static step scope.
    if (ctx.declaredWorkspaceScopes === undefined || !decl.scope) return;
    const workspaceSet = new Set(ctx.declaredWorkspaceScopes);
    for (const s of decl.scope) {
        if (!workspaceSet.has(s)) {
            errors.push({
                code: 'workflow_scope_widens',
                field: 'scope',
                message: `workflow.scope contains "${s}" which is not in the workspace's declared scopes`,
            });
        }
    }
}

// ─── workflow_template_unresolved ───────────────────────────────────────

/**
 * Find every template reference (`{{ ... }}` and `${{ ... }}`) inside a
 * workflow's string-valued fields, and verify each refers to a known
 * scope chain root.
 *
 * Valid roots:
 *   - `inputs.<name>[...]`            (workflow-level input must exist)
 *   - `steps.<id>.output[.<path>]`    (referenced step must exist)
 *   - `context.<field>`               (any context.<x> permitted)
 *
 * A reference like `inputs` (no dot) or `steps.unknown.output` flags.
 */
function checkTemplateRefs(
    decl: WorkflowDeclaration,
    errors: WorkflowValidationError[],
): void {
    const knownInputs = new Set(Object.keys(decl.inputs ?? {}));
    const knownSteps = new Set(Object.keys(decl.steps));

    for (const [stepId, step] of Object.entries(decl.steps)) {
        for (const ref of collectTemplateRefs(step)) {
            const err = checkTemplateReference(
                ref.text, knownInputs, knownSteps,
            );
            if (err) {
                errors.push({
                    code: 'workflow_template_unresolved',
                    stepId,
                    field: ref.field,
                    message: `step "${stepId}".${ref.field} references unresolved template "${ref.text}": ${err}`,
                });
            }
        }
    }

    // `outputs[].from` accepts two shapes:
    //   - a literal step id ("compute-metric") → idiomatic; pair with
    //     `pick: <path>` for sub-field extraction.
    //   - a template expression ("${{ steps.X.outputs.Y }}") → also
    //     accepted; the embedded `steps.X.<path>` ref is validated
    //     through the same `checkTemplateReference` path as inline
    //     refs in step params/prompts.
    // Anything else (plain string that isn't a step id and isn't a
    // template) is rejected as an unknown step.
    if (decl.outputs) {
        const stepIds = new Set(Object.keys(decl.steps));
        for (const [outName, out] of Object.entries(decl.outputs)) {
            const fromArr = Array.isArray(out.from) ? out.from : [out.from];
            for (const from of fromArr) {
                if (stepIds.has(from)) continue;
                // Template expression — validate the embedded ref.
                if (looksLikeTemplate(from)) {
                    TEMPLATE_RE.lastIndex = 0;
                    let m: RegExpExecArray | null;
                    while ((m = TEMPLATE_RE.exec(from)) !== null) {
                        const refErr = checkTemplateReference(
                            m[1].trim(), knownInputs, knownSteps,
                        );
                        if (refErr) {
                            errors.push({
                                code: 'workflow_template_unresolved',
                                field: `outputs.${outName}.from`,
                                message: `outputs.${outName}.from references unresolved template "${m[1].trim()}": ${refErr}`,
                            });
                        }
                    }
                    continue;
                }
                errors.push({
                    code: 'workflow_template_unresolved',
                    field: `outputs.${outName}.from`,
                    message: `outputs.${outName}.from references unknown step "${from}"`,
                });
            }
        }
    }
}

function looksLikeTemplate(s: string): boolean {
    return s.includes('{{') && s.includes('}}');
}

interface TemplateRef {
    text: string;
    field: string;
}

const TEMPLATE_RE = /\$?\{\{\s*([^{}]+?)\s*\}\}/g;

function collectTemplateRefs(step: WorkflowStep): TemplateRef[] {
    const refs: TemplateRef[] = [];
    const visit = (val: unknown, field: string): void => {
        if (typeof val === 'string') {
            TEMPLATE_RE.lastIndex = 0;
            let m: RegExpExecArray | null;
            while ((m = TEMPLATE_RE.exec(val)) !== null) {
                refs.push({ text: m[1].trim(), field });
            }
        } else if (Array.isArray(val)) {
            val.forEach((x, i) => visit(x, `${field}[${i}]`));
        } else if (val && typeof val === 'object') {
            for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
                visit(v, `${field}.${k}`);
            }
        }
    };
    if (isAgentStep(step)) {
        const a: AgentStep = step;
        if (a.prompt !== undefined) visit(a.prompt, 'prompt');
        if (typeof a.systemPrompt === 'string') visit(a.systemPrompt, 'systemPrompt');
        else if (a.systemPrompt && a.systemPrompt.append) {
            visit(a.systemPrompt.append, 'systemPrompt.append');
        }
    } else {
        switch (step.kind) {
            case 'route': {
                const r = step as RouteStep;
                if (r.params) visit(r.params, 'params');
                break;
            }
            case 'input': {
                const i = step as InputStep;
                if (i.defaults) visit(i.defaults, 'defaults');
                visit(i.prompt, 'prompt');
                break;
            }
        }
    }
    return refs;
}

function checkTemplateReference(
    expr: string,
    knownInputs: Set<string>,
    knownSteps: Set<string>,
): string | null {
    // Trim simple `| json` / `| ...` filter pipes — we just check the
    // left-hand-side path.
    const path = expr.split('|')[0].trim();
    const parts = path.split('.');
    const root = parts[0];

    if (root === 'inputs') {
        if (parts.length < 2) return 'reference must be of the form inputs.<name>';
        const name = parts[1];
        if (!knownInputs.has(name)) {
            return `unknown workflow input "${name}" (known: ${[...knownInputs].sort().join(', ') || '<none>'})`;
        }
        return null;
    }
    if (root === 'steps') {
        if (parts.length < 2) {
            return 'reference must be of the form steps.<id>.outputs[.<path>] or steps.<id>.<field>';
        }
        const sid = parts[1];
        if (!knownSteps.has(sid)) {
            return `unknown step "${sid}"`;
        }
        // After `steps.<id>` we accept either:
        //   - `steps.<id>` (whole output object)
        //   - `steps.<id>.outputs[.<path>]` (engine's magic skip segment;
        //     the runtime resolver strips `outputs` and continues into
        //     the step's output object — see `engine/run-graph.ts:resolveExpression`)
        //   - `steps.<id>.<field>` (direct field access on the step's
        //     output object — equivalent to the `outputs`-prefixed form
        //     without the magic segment)
        // Field-name validity isn't checkable without a per-step output
        // schema, so anything past the step id passes lint and is
        // resolved (or undef-resolved) at runtime.
        return null;
    }
    if (root === 'context') {
        if (parts.length < 2) return 'reference must be of the form context.<field>';
        return null;
    }
    return `unknown reference root "${root}" (expected inputs.* | steps.* | context.*)`;
}

// ─── workflow_input_schema_invalid ──────────────────────────────────────

/**
 * Lightweight JSON Schema sanity check. We don't pull in a full
 * draft-07 validator — that's a runtime concern. Instead we check:
 *   - `type` is one of the standard JSON Schema types
 *   - `properties` is an object if present
 *   - `required` is an array of strings if present
 *   - each property's nested schema also passes the same check
 */
function checkInputSchemas(
    decl: WorkflowDeclaration,
    errors: WorkflowValidationError[],
): void {
    for (const [stepId, step] of Object.entries(decl.steps)) {
        if (step.kind !== 'input') continue;
        const issues = validateJsonSchemaShape((step as InputStep).schema);
        for (const issue of issues) {
            errors.push({
                code: 'workflow_input_schema_invalid',
                stepId,
                field: `schema${issue.path}`,
                message: `input step "${stepId}".schema is invalid${issue.path ? ' at ' + issue.path : ''}: ${issue.message}`,
            });
        }
    }
}

const JSON_SCHEMA_TYPES = new Set([
    'string', 'number', 'integer', 'boolean', 'object', 'array', 'null',
]);

interface SchemaIssue {
    path: string;
    message: string;
}

function validateJsonSchemaShape(
    schema: unknown,
    path = '',
): SchemaIssue[] {
    const issues: SchemaIssue[] = [];
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
        issues.push({ path, message: 'must be an object' });
        return issues;
    }
    const s = schema as Record<string, unknown>;
    if (s.type !== undefined) {
        if (typeof s.type === 'string') {
            if (!JSON_SCHEMA_TYPES.has(s.type)) {
                issues.push({
                    path: `${path}.type`,
                    message: `unknown type "${s.type}" (expected one of ${[...JSON_SCHEMA_TYPES].join(' | ')})`,
                });
            }
        } else if (Array.isArray(s.type)) {
            for (const t of s.type) {
                if (typeof t !== 'string' || !JSON_SCHEMA_TYPES.has(t)) {
                    issues.push({
                        path: `${path}.type`,
                        message: `array form may only contain JSON Schema types (got ${JSON.stringify(t)})`,
                    });
                }
            }
        } else {
            issues.push({
                path: `${path}.type`,
                message: 'must be a string or array of strings',
            });
        }
    }
    if (s.properties !== undefined) {
        if (typeof s.properties !== 'object' || s.properties === null || Array.isArray(s.properties)) {
            issues.push({ path: `${path}.properties`, message: 'must be an object' });
        } else {
            for (const [k, v] of Object.entries(s.properties as Record<string, unknown>)) {
                issues.push(...validateJsonSchemaShape(v, `${path}.properties.${k}`));
            }
        }
    }
    if (s.required !== undefined) {
        if (!Array.isArray(s.required) || !s.required.every(x => typeof x === 'string')) {
            issues.push({ path: `${path}.required`, message: 'must be an array of strings' });
        }
    }
    if (s.items !== undefined) {
        issues.push(...validateJsonSchemaShape(s.items, `${path}.items`));
    }
    return issues;
}

// ─── exports for downstream lint integration ────────────────────────────

export type { WorkflowLintCode } from './types';
