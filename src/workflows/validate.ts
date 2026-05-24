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
    SubworkflowStep,
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
    'subworkflow',
    'parallel',
]);

/** Events that satisfy a step's "no dead-end" requirement when no `next:`. */
const DEFAULT_TERMINAL_EVENTS: Record<string, string[]> = {
    // For each kind, what *must* be routable. If `next:` is absent, `on:`
    // must cover the default success event.
    route: ['success'],
    input: ['submitted'],
    agent: ['success'],
    subworkflow: ['success'],
    parallel: ['success'],
};

export function validateWorkflow(
    decl: WorkflowDeclaration,
    ctx: WorkflowValidateContext = {},
): WorkflowValidationResult {
    const errors: WorkflowValidationError[] = [];

    checkNameMatchesFilename(decl, ctx, errors);
    checkSchemaShape(decl, ctx, errors);
    checkStepKindsKnown(decl, errors);
    checkReachabilityAndDeadEnds(decl, errors);
    checkRoutes(decl, ctx, errors);
    checkHarnesses(decl, ctx, errors);
    checkSubworkflows(decl, ctx, errors);
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

// ─── workflow_step_unreachable + workflow_step_dead_end ─────────────────

function checkReachabilityAndDeadEnds(
    decl: WorkflowDeclaration,
    errors: WorkflowValidationError[],
): void {
    const stepIds = Object.keys(decl.steps);
    if (stepIds.length === 0) return;

    // Build the edge set. Edges go from sourceId → targetId; target may
    // be a step id, "outputs", or "outputs.<name>".
    const incoming = new Map<string, Set<string>>();
    for (const id of stepIds) incoming.set(id, new Set());

    for (const [srcId, step] of Object.entries(decl.steps)) {
        const targets: string[] = [];
        if (step.next !== undefined) targets.push(step.next);
        if (step.on) {
            for (const t of Object.values(step.on)) targets.push(t);
        }
        if (step.kind === 'input' && step.timeout) {
            targets.push(step.timeout.then);
        }
        for (const t of targets) {
            const targetStepId = resolveEdgeTarget(t);
            if (targetStepId && incoming.has(targetStepId)) {
                incoming.get(targetStepId)!.add(srcId);
            }
        }
    }

    // The first declared step is implicitly reachable (the entry point).
    // Any subsequent step with no incoming edge is unreachable.
    const firstStepId = stepIds[0];
    for (const id of stepIds) {
        if (id === firstStepId) continue;
        if ((incoming.get(id)?.size ?? 0) === 0) {
            errors.push({
                code: 'workflow_step_unreachable',
                stepId: id,
                message: `step "${id}" has no incoming edge and is not the entry step`,
            });
        }
    }

    // Dead-end: no `next:` AND `on:` doesn't cover the kind's default
    // success event. Acceptable: a step with `next: outputs` or
    // `next: outputs.<name>` IS a terminal — not a dead-end.
    for (const [id, step] of Object.entries(decl.steps)) {
        if (step.next !== undefined) continue;
        if (!KNOWN_STEP_KINDS.has(step.kind)) continue;
        const required = DEFAULT_TERMINAL_EVENTS[step.kind] ?? [];
        const covered = step.on ?? {};
        const missing = required.filter(ev => !(ev in covered));
        if (missing.length > 0) {
            errors.push({
                code: 'workflow_step_dead_end',
                stepId: id,
                message: `step "${id}" has no "next:" and "on:" does not cover required event(s): ${missing.join(', ')}`,
            });
        }
    }
}

function resolveEdgeTarget(target: string): string | undefined {
    if (target === 'outputs' || target.startsWith('outputs.')) return undefined;
    return target;
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

// ─── workflow_subworkflow_unknown ───────────────────────────────────────

function checkSubworkflows(
    decl: WorkflowDeclaration,
    ctx: WorkflowValidateContext,
    errors: WorkflowValidationError[],
): void {
    if (!ctx.knownWorkflows) return;
    for (const [id, step] of Object.entries(decl.steps)) {
        if (step.kind !== 'subworkflow') continue;
        const ref = (step as SubworkflowStep).ref;
        // Path refs (./foo.yaml) are not checked here — only slug refs.
        if (ref.includes('/') || ref.endsWith('.yaml') || ref.endsWith('.yml')) continue;
        if (!ctx.knownWorkflows.has(ref)) {
            errors.push({
                code: 'workflow_subworkflow_unknown',
                stepId: id,
                field: 'ref',
                message: `subworkflow step "${id}".ref "${ref}" does not resolve to a known workflow`,
            });
        }
    }
}

// ─── workflow_scope_widens ──────────────────────────────────────────────

function checkScopeWidens(
    decl: WorkflowDeclaration,
    ctx: WorkflowValidateContext,
    errors: WorkflowValidationError[],
): void {
    // A step (subworkflow) declaring scopes outside the workflow's own
    // declared scope is a widening — flag it. The workspace-level
    // narrowing applies at dispatch, not here.
    const declaredSet = new Set(decl.scope ?? []);
    // Optionally additionally check against workspace-declared scopes.
    const workspaceSet = new Set(ctx.declaredWorkspaceScopes ?? []);

    for (const [id, step] of Object.entries(decl.steps)) {
        if (step.kind !== 'subworkflow') continue;
        const stepScope = (step as SubworkflowStep).scope;
        if (!stepScope) continue;
        for (const s of stepScope) {
            if (decl.scope !== undefined && !declaredSet.has(s)) {
                errors.push({
                    code: 'workflow_scope_widens',
                    stepId: id,
                    field: 'scope',
                    message: `subworkflow step "${id}".scope contains "${s}" which the workflow's top-level scope does not declare`,
                });
                continue;
            }
            if (
                ctx.declaredWorkspaceScopes !== undefined &&
                !workspaceSet.has(s)
            ) {
                errors.push({
                    code: 'workflow_scope_widens',
                    stepId: id,
                    field: 'scope',
                    message: `subworkflow step "${id}".scope contains "${s}" which is not in the workspace's declared scopes`,
                });
            }
        }
    }

    // Also: top-level workflow.scope shouldn't widen vs workspace.
    if (ctx.declaredWorkspaceScopes !== undefined && decl.scope) {
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

    // Also check outputs[].pick: pick paths reference step.output.<...>;
    // their `from` must be a known step.
    if (decl.outputs) {
        const stepIds = new Set(Object.keys(decl.steps));
        for (const [outName, out] of Object.entries(decl.outputs)) {
            const fromArr = Array.isArray(out.from) ? out.from : [out.from];
            for (const from of fromArr) {
                if (!stepIds.has(from)) {
                    errors.push({
                        code: 'workflow_template_unresolved',
                        field: `outputs.${outName}.from`,
                        message: `outputs.${outName}.from references unknown step "${from}"`,
                    });
                }
            }
        }
    }
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
            case 'subworkflow': {
                const s = step as SubworkflowStep;
                if (s.inputs) visit(s.inputs, 'inputs');
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
        if (parts.length < 3) {
            return 'reference must be of the form steps.<id>.output[...]';
        }
        const sid = parts[1];
        if (!knownSteps.has(sid)) {
            return `unknown step "${sid}"`;
        }
        if (parts[2] !== 'output') {
            return `steps.${sid}.<x> — only ".output" is addressable (got "${parts[2]}")`;
        }
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
