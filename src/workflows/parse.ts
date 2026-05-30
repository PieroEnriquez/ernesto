/**
 * Parse a workflow YAML blob into a `WorkflowDeclaration`.
 *
 * Validation here is *structural* — enough to enforce the type
 * surface. Semantic validation (unreachable steps, unknown routes,
 * template resolution, etc.) lives in `validate.ts`.
 */

import { load as yamlLoad, YAMLException } from 'js-yaml';
import type {
    WorkflowDeclaration,
    WorkflowStep,
    AgentStep,
    AgentHarness,
    RouteStep,
    WorkflowInput,
    WorkflowOutput,
} from './types';

export interface ParseWorkflowOptions {
    /** Used in error messages. */
    filename?: string;
}

export function parseWorkflowYaml(
    text: string,
    opts: ParseWorkflowOptions = {},
): WorkflowDeclaration {
    const filename = opts.filename ?? '<workflow>';
    let raw: unknown;
    try {
        raw = yamlLoad(text);
    } catch (e) {
        if (e instanceof YAMLException) {
            const mark = e.mark;
            const where = mark
                ? ` (line ${mark.line + 1}, column ${mark.column + 1})`
                : '';
            throw new Error(
                `${filename}: malformed YAML${where}: ${e.reason ?? e.message}`,
            );
        }
        throw new Error(`${filename}: malformed YAML: ${(e as Error).message}`);
    }
    if (raw === null || raw === undefined) {
        throw new Error(`${filename}: workflow YAML is empty`);
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`${filename}: workflow YAML must be a mapping at the root`);
    }
    return projectWorkflow(raw as Record<string, unknown>, filename);
}

// ─── projection (raw → typed) ────────────────────────────────────────────

const ALLOWED_TOP_KEYS = new Set([
    'name', 'description', 'version', 'callableAs', 'scope',
    'tags', 'owner', 'inputs', 'steps', 'outputs',
    'trigger', 'concurrency',
]);

function projectWorkflow(
    raw: Record<string, unknown>,
    filename: string,
): WorkflowDeclaration {
    for (const k of Object.keys(raw)) {
        if (!ALLOWED_TOP_KEYS.has(k)) {
            throw new Error(
                `${filename}: unknown top-level key "${k}" ` +
                `(allowed: ${[...ALLOWED_TOP_KEYS].sort().join(', ')})`,
            );
        }
    }

    const name = requireString(raw, 'name', filename);
    const description = requireString(raw, 'description', filename);
    const version = raw.version;
    if (version !== 1) {
        throw new Error(
            `${filename}: "version" must be the literal number 1 (got ${JSON.stringify(version)})`,
        );
    }

    const steps = projectSteps(raw.steps, filename);

    const decl: WorkflowDeclaration = {
        name,
        description,
        version: 1,
        steps,
    };

    const callableAs = projectStringArray(raw.callableAs, 'callableAs', filename);
    if (callableAs) decl.callableAs = callableAs;
    const scope = projectStringArray(raw.scope, 'scope', filename);
    if (scope) decl.scope = scope;
    const tags = projectStringArray(raw.tags, 'tags', filename);
    if (tags) decl.tags = tags;
    if (raw.owner !== undefined) {
        if (typeof raw.owner !== 'string') {
            throw new Error(`${filename}: "owner" must be a string`);
        }
        decl.owner = raw.owner;
    }
    const inputs = projectInputs(raw.inputs, filename);
    if (inputs) decl.inputs = inputs;
    const outputs = projectOutputs(raw.outputs, filename);
    if (outputs) decl.outputs = outputs;
    if (raw.concurrency !== undefined) {
        decl.concurrency = asInt(raw.concurrency, 'concurrency', filename);
    }
    const trigger = projectTrigger(raw.trigger, filename);
    if (trigger) decl.trigger = trigger;

    return decl;
}

function projectTrigger(
    v: unknown,
    filename: string,
): WorkflowDeclaration['trigger'] {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'object' || Array.isArray(v)) {
        throw new Error(`${filename}: "trigger" must be a mapping`);
    }
    const raw = v as Record<string, unknown>;
    const out: NonNullable<WorkflowDeclaration['trigger']> = {};
    if (raw.cron !== undefined) {
        if (typeof raw.cron !== 'string') {
            throw new Error(`${filename}: "trigger.cron" must be a string`);
        }
        out.cron = raw.cron;
    }
    if (raw.inputs !== undefined) {
        out.inputs = asRecord(raw.inputs, 'trigger.inputs', filename);
    }
    return out;
}

function projectSteps(
    v: unknown,
    filename: string,
): Record<string, WorkflowStep> {
    if (v === undefined || v === null) {
        throw new Error(`${filename}: "steps" is required`);
    }
    if (typeof v !== 'object' || Array.isArray(v)) {
        throw new Error(`${filename}: "steps" must be a mapping`);
    }
    const raw = v as Record<string, unknown>;
    const out: Record<string, WorkflowStep> = {};
    for (const [stepId, stepRaw] of Object.entries(raw)) {
        out[stepId] = projectStep(stepId, stepRaw, filename);
    }
    if (Object.keys(out).length === 0) {
        throw new Error(`${filename}: "steps" must declare at least one step`);
    }
    return out;
}

function projectStep(
    stepId: string,
    v: unknown,
    filename: string,
): WorkflowStep {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
        throw new Error(`${filename}: step "${stepId}" must be a mapping`);
    }
    const raw = v as Record<string, unknown>;
    const kind = raw.kind;
    if (typeof kind !== 'string') {
        throw new Error(
            `${filename}: step "${stepId}" is missing "kind:" ` +
            `(expected one of call | route | input | agent | group)`,
        );
    }
    const base = projectStepBase(raw, stepId, filename);

    switch (kind) {
        // `call` is the new canonical name for the dispatch-by-URI
        // step kind; `route` is the legacy spelling, kept as a parser
        // alias during the workspace-wide rename. Both produce the
        // same `kind: 'route'` internal shape — when the rename
        // settles, the internal kind will move to `'call'` and the
        // `route` alias will retire.
        case 'call':
        case 'route': {
            const uri = requireString(raw, 'uri', `${filename}: step "${stepId}"`);
            return {
                kind: 'route',
                uri,
                ...(raw.params !== undefined ? { params: asRecord(raw.params, `step "${stepId}".params`, filename) } : {}),
                ...(raw.render !== undefined ? { render: projectRender(raw.render, stepId, filename) } : {}),
                ...(raw.timeoutMs !== undefined ? { timeoutMs: asInt(raw.timeoutMs, `step "${stepId}".timeoutMs`, filename) } : {}),
                ...(raw.retries !== undefined ? { retries: asInt(raw.retries, `step "${stepId}".retries`, filename) } : {}),
                ...base,
            };
        }
        case 'input': {
            if (raw.schema === undefined) {
                throw new Error(`${filename}: input step "${stepId}" missing "schema"`);
            }
            if (typeof raw.schema !== 'object' || raw.schema === null || Array.isArray(raw.schema)) {
                throw new Error(`${filename}: input step "${stepId}".schema must be a JSON Schema object`);
            }
            const prompt = requireString(raw, 'prompt', `${filename}: input step "${stepId}"`);
            return {
                kind: 'input',
                schema: raw.schema as Record<string, unknown>,
                prompt,
                ...(raw.defaults !== undefined ? { defaults: asRecord(raw.defaults, `step "${stepId}".defaults`, filename) } : {}),
                ...(raw.skipIfProvided !== undefined ? { skipIfProvided: asBoolean(raw.skipIfProvided, `step "${stepId}".skipIfProvided`, filename) } : {}),
                ...(raw.timeout !== undefined ? { timeout: projectTimeout(raw.timeout, stepId, filename) } : {}),
                ...base,
            };
        }
        case 'agent': {
            // Single agent kind. Reference form (ref:) and inline form
            // (model + systemPrompt + prompt) share the same shape;
            // validate.ts enforces "ref XOR required inline fields".
            const harness = projectHarness(raw.harness, stepId, filename);
            const ref = raw.ref === undefined
                ? undefined
                : requireString(raw, 'ref', `${filename}: agent step "${stepId}"`);
            const model = raw.model === undefined
                ? undefined
                : requireString(raw, 'model', `${filename}: agent step "${stepId}"`);
            const prompt = raw.prompt === undefined
                ? undefined
                : requireString(raw, 'prompt', `${filename}: agent step "${stepId}"`);
            const systemPrompt = raw.systemPrompt === undefined
                ? undefined
                : projectSystemPrompt(raw.systemPrompt, stepId, filename);
            const outputFormat = projectOutputFormat(raw.outputFormat, stepId, filename);
            // providerOverride only legal when resolved harness is fragua-pi.
            // Parser-level rule: if the step pins `harness:` to anything
            // other than fragua-pi, reject. (When `harness:` is absent
            // here, leave to validate.ts after ref resolution.)
            if (raw.providerOverride !== undefined && harness && harness !== 'fragua-pi') {
                throw new Error(
                    `${filename}: agent step "${stepId}" has "providerOverride" but harness is "${harness}"; ` +
                    `providerOverride is only valid when harness resolves to "fragua-pi"`,
                );
            }
            const providerOverride = projectProviderOverride(raw.providerOverride, stepId, filename);
            // Inline form requires model + systemPrompt + prompt. Ref
            // form draws those from the referenced agent declaration
            // and may omit them. Parser enforces the structural rule;
            // validate.ts later checks that `ref` resolves.
            if (ref === undefined) {
                if (model === undefined) {
                    throw new Error(
                        `${filename}: agent step "${stepId}" must declare either "ref" or inline "model" (inline form needs model + systemPrompt + prompt)`,
                    );
                }
                if (systemPrompt === undefined) {
                    throw new Error(
                        `${filename}: agent step "${stepId}" (inline form) is missing "systemPrompt"`,
                    );
                }
                if (prompt === undefined) {
                    throw new Error(
                        `${filename}: agent step "${stepId}" (inline form) is missing "prompt"`,
                    );
                }
            }
            const out: AgentStep = {
                kind: 'agent',
                ...(ref !== undefined ? { ref } : {}),
                ...(raw.inputs !== undefined ? { inputs: asRecord(raw.inputs, `step "${stepId}".inputs`, filename) } : {}),
                ...(harness !== undefined ? { harness } : {}),
                ...(model !== undefined ? { model } : {}),
                ...(systemPrompt !== undefined ? { systemPrompt } : {}),
                ...(raw.maxTurns !== undefined ? { maxTurns: asInt(raw.maxTurns, `step "${stepId}".maxTurns`, filename) } : {}),
                ...(raw.mcpServers !== undefined ? { mcpServers: projectStringArray(raw.mcpServers, `step "${stepId}".mcpServers`, filename) ?? [] } : {}),
                ...(raw.tools !== undefined ? { tools: projectStringArray(raw.tools, `step "${stepId}".tools`, filename) ?? [] } : {}),
                ...(raw.disallowedTools !== undefined ? { disallowedTools: projectStringArray(raw.disallowedTools, `step "${stepId}".disallowedTools`, filename) ?? [] } : {}),
                ...(outputFormat ? { outputFormat } : {}),
                ...(prompt !== undefined ? { prompt } : {}),
                ...(raw.subagents !== undefined ? { subagents: projectSubagents(raw.subagents, stepId, filename) } : {}),
                ...(providerOverride ? { providerOverride } : {}),
                ...base,
            };
            return out;
        }
        case 'group': {
            // Nested sub-DAG. `steps` recurse via projectStep so each
            // child parses through the normal path; the engine runs the
            // sub-graph with its own `concurrency`. `${{ }}` tokens in
            // children resolve at run time.
            const stepsRaw = raw.steps;
            if (typeof stepsRaw !== 'object' || stepsRaw === null || Array.isArray(stepsRaw)) {
                throw new Error(
                    `${filename}: group step "${stepId}".steps must be a mapping of stepId → step`,
                );
            }
            const steps: Record<string, WorkflowStep> = {};
            for (const [sk, sv] of Object.entries(stepsRaw as Record<string, unknown>)) {
                steps[sk] = projectStep(`${stepId}.${sk}`, sv, filename);
            }
            return {
                kind: 'group',
                steps,
                ...(raw.concurrency !== undefined
                    ? { concurrency: asInt(raw.concurrency, `step "${stepId}".concurrency`, filename) }
                    : {}),
                ...(raw.outputs !== undefined
                    ? { outputs: projectOutputs(raw.outputs, filename) ?? {} }
                    : {}),
                ...base,
            };
        }
        default:
            // Unknown kinds parse through; `validate.ts` emits
            // `workflow_unknown_kind`. We still wrap the raw shape so
            // downstream consumers can introspect.
            return {
                // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
                kind: kind as 'route',
                uri: typeof raw.uri === 'string' ? raw.uri : '<unknown-kind>',
                ...base,
            };
    }
}

function projectRender(
    v: unknown,
    stepId: string,
    filename: string,
): RouteStepRender {
    const allowed = ['chart', 'table', 'value', 'markdown', 'json', 'none'];
    if (typeof v === 'string' && allowed.includes(v)) {
        return v as RouteStepRender;
    }
    // Manifest form — `RenderEntry[]`. Shape-check just the surface:
    // every entry must be an object with a `path` string + `ui` string.
    // Deeper shape validation lives in the route render walker; bad
    // entries silently project nothing rather than blocking the parse.
    if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
            const e = v[i];
            if (!e || typeof e !== 'object' || Array.isArray(e)) {
                throw new Error(
                    `${filename}: step "${stepId}".render[${i}] must be an object`,
                );
            }
            const o = e as { path?: unknown; ui?: unknown };
            if (typeof o.path !== 'string') {
                throw new Error(
                    `${filename}: step "${stepId}".render[${i}].path must be a string`,
                );
            }
            if (typeof o.ui !== 'string') {
                throw new Error(
                    `${filename}: step "${stepId}".render[${i}].ui must be a string`,
                );
            }
        }
        return v as unknown as RouteStepRender;
    }
    throw new Error(
        `${filename}: step "${stepId}".render must be a string hint (${allowed.join(' | ')}) or a RenderEntry[] manifest`,
    );
}
// Mirror of `RouteStep['render']`. The validator only shape-checks
// `{ path, ui }` at the array form (deeper validation lives in
// `applyRenderManifest`); the parse-time return is structurally a
// `RenderEntry[]` since each entry has the two required string
// fields. The runtime walker is permissive about extra fields.
type RouteStepRender = NonNullable<RouteStep['render']>;

/** Project the DAG metadata every step may carry: `depends`, `next`
 *  (linear sugar), `skipIf`, `fallback`. Spread into each step's
 *  typed shape as `...base`. */
function projectStepBase(
    raw: Record<string, unknown>,
    stepId: string,
    filename: string,
): { depends?: string[]; next?: string; skipIf?: string; fallback?: string } {
    const base: { depends?: string[]; next?: string; skipIf?: string; fallback?: string } = {};
    if (raw.depends !== undefined) {
        base.depends = projectStringArray(raw.depends, `step "${stepId}".depends`, filename) ?? [];
    }
    if (raw.next !== undefined) {
        base.next = asString(raw.next, `${filename}: step "${stepId}".next`);
    }
    if (raw.skipIf !== undefined) {
        base.skipIf = asString(raw.skipIf, `${filename}: step "${stepId}".skipIf`);
    }
    if (raw.fallback !== undefined) {
        base.fallback = asString(raw.fallback, `${filename}: step "${stepId}".fallback`);
    }
    return base;
}

function projectTimeout(
    v: unknown,
    stepId: string,
    filename: string,
): { afterMs: number; then: string } {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${filename}: step "${stepId}".timeout must be { afterMs, then }`);
    }
    const r = v as Record<string, unknown>;
    const afterMs = asInt(r.afterMs, `step "${stepId}".timeout.afterMs`, filename);
    const then = asString(r.then, `step "${stepId}".timeout.then`);
    return { afterMs, then };
}

function projectSystemPrompt(
    v: unknown,
    stepId: string,
    filename: string,
): import('./types').SystemPromptConfig {
    if (typeof v === 'string') return v;
    if (
        v !== null && typeof v === 'object' && !Array.isArray(v) &&
        (v as Record<string, unknown>).type === 'preset' &&
        (v as Record<string, unknown>).preset === 'claude_code'
    ) {
        const o = v as { type: 'preset'; preset: 'claude_code'; append?: unknown };
        if (o.append !== undefined && typeof o.append !== 'string') {
            throw new Error(`${filename}: agent step "${stepId}".systemPrompt.append must be a string`);
        }
        return {
            type: 'preset',
            preset: 'claude_code',
            ...(typeof o.append === 'string' ? { append: o.append } : {}),
        };
    }
    throw new Error(
        `${filename}: agent step "${stepId}".systemPrompt must be a string or { type: preset, preset: claude_code, append? }`,
    );
}

function projectOutputFormat(
    v: unknown,
    stepId: string,
    filename: string,
): import('./types').JsonSchemaOutputFormat | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${filename}: agent step "${stepId}".outputFormat must be an object`);
    }
    const o = v as Record<string, unknown>;
    if (o.type !== 'json_schema') {
        throw new Error(`${filename}: agent step "${stepId}".outputFormat.type must be "json_schema"`);
    }
    if (typeof o.schema !== 'object' || o.schema === null || Array.isArray(o.schema)) {
        throw new Error(`${filename}: agent step "${stepId}".outputFormat.schema must be an object`);
    }
    return {
        type: 'json_schema',
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
        schema: o.schema as Record<string, unknown>,
    };
}

function projectSubagents(
    v: unknown,
    stepId: string,
    filename: string,
): Record<string, { ref: string }> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${filename}: agent step "${stepId}".subagents must be a mapping`);
    }
    const out: Record<string, { ref: string }> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val !== 'object' || val === null || Array.isArray(val)) {
            throw new Error(`${filename}: agent step "${stepId}".subagents.${k} must be { ref: <string> }`);
        }
        const ref = (val as Record<string, unknown>).ref;
        if (typeof ref !== 'string' || ref.length === 0) {
            throw new Error(`${filename}: agent step "${stepId}".subagents.${k}.ref must be a non-empty string`);
        }
        out[k] = { ref };
    }
    return out;
}

function projectHarness(
    v: unknown,
    stepId: string,
    filename: string,
): AgentHarness | undefined {
    if (v === undefined) return undefined;
    if (v === 'cas' || v === 'cursor' || v === 'fragua-pi' || v === 'remote-vm') {
        return v;
    }
    throw new Error(
        `${filename}: agent step "${stepId}".harness must be "cas" | "cursor" | "fragua-pi" | "remote-vm"`,
    );
}

const PROVIDER_OVERRIDES = new Set([
    'anthropic', 'openai', 'google', 'ollama', 'openrouter',
]);

function projectProviderOverride(
    v: unknown,
    stepId: string,
    filename: string,
): 'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter' | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || !PROVIDER_OVERRIDES.has(v)) {
        throw new Error(
            `${filename}: agent step "${stepId}".providerOverride must be one of ${[...PROVIDER_OVERRIDES].join(' | ')}`,
        );
    }
    return v as 'anthropic' | 'openai' | 'google' | 'ollama' | 'openrouter';
}

function projectInputs(
    v: unknown,
    filename: string,
): Record<string, WorkflowInput> | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${filename}: "inputs" must be a mapping`);
    }
    const out: Record<string, WorkflowInput> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = projectInput(k, val, filename);
    }
    return out;
}

const INPUT_TYPES = new Set(['string', 'number', 'boolean', 'date_range', 'object', 'array']);

function projectInput(
    name: string,
    v: unknown,
    filename: string,
): WorkflowInput {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${filename}: inputs.${name} must be a mapping`);
    }
    const r = v as Record<string, unknown>;
    const type = r.type;
    if (typeof type !== 'string' || !INPUT_TYPES.has(type)) {
        throw new Error(
            `${filename}: inputs.${name}.type must be one of ${[...INPUT_TYPES].join(' | ')}`,
        );
    }
    const out: WorkflowInput = { type: type as WorkflowInput['type'] };
    if (r.enum !== undefined) {
        if (!Array.isArray(r.enum)) {
            throw new Error(`${filename}: inputs.${name}.enum must be an array`);
        }
        out.enum = r.enum as unknown[];
    }
    if (r.default !== undefined) out.default = r.default;
    if (r.description !== undefined) {
        if (typeof r.description !== 'string') {
            throw new Error(`${filename}: inputs.${name}.description must be a string`);
        }
        out.description = r.description;
    }
    if (r.properties !== undefined) {
        if (typeof r.properties !== 'object' || r.properties === null || Array.isArray(r.properties)) {
            throw new Error(`${filename}: inputs.${name}.properties must be a mapping`);
        }
        const props: Record<string, WorkflowInput> = {};
        for (const [pk, pv] of Object.entries(r.properties as Record<string, unknown>)) {
            props[pk] = projectInput(`${name}.${pk}`, pv, filename);
        }
        out.properties = props;
    }
    if (r.required !== undefined) {
        const req = projectStringArray(r.required, `inputs.${name}.required`, filename);
        if (req) out.required = req;
    }
    return out;
}

function projectOutputs(
    v: unknown,
    filename: string,
): Record<string, WorkflowOutput> | undefined {
    if (v === undefined) return undefined;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${filename}: "outputs" must be a mapping`);
    }
    const out: Record<string, WorkflowOutput> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = projectOutput(k, val, filename);
    }
    return out;
}

function projectOutput(
    name: string,
    v: unknown,
    filename: string,
): WorkflowOutput {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${filename}: outputs.${name} must be a mapping`);
    }
    const r = v as Record<string, unknown>;
    if (r.from === undefined) {
        throw new Error(`${filename}: outputs.${name}.from is required`);
    }
    let from: string | string[];
    if (typeof r.from === 'string') from = r.from;
    else if (Array.isArray(r.from) && r.from.every(x => typeof x === 'string')) {
        from = r.from as string[];
    } else {
        throw new Error(`${filename}: outputs.${name}.from must be a string or array of strings`);
    }
    const out: WorkflowOutput = { from };
    if (r.pick !== undefined) {
        if (typeof r.pick !== 'string') {
            throw new Error(`${filename}: outputs.${name}.pick must be a string`);
        }
        out.pick = r.pick;
    }
    if (r.shape !== undefined) {
        if (r.shape !== 'dashboard' && r.shape !== 'agent_result' && r.shape !== 'value') {
            throw new Error(`${filename}: outputs.${name}.shape must be one of dashboard | agent_result | value`);
        }
        out.shape = r.shape;
    }
    return out;
}

// ─── primitive helpers ───────────────────────────────────────────────────

function requireString(
    obj: Record<string, unknown>,
    key: string,
    where: string,
): string {
    const v = obj[key];
    if (typeof v !== 'string' || v.length === 0) {
        throw new Error(`${where}: "${key}" must be a non-empty string`);
    }
    return v;
}

function asString(v: unknown, where: string): string {
    if (typeof v !== 'string') throw new Error(`${where} must be a string`);
    return v;
}

function asInt(v: unknown, where: string, filename: string): number {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
        throw new Error(`${filename}: ${where} must be a non-negative integer`);
    }
    return v;
}

function asBoolean(v: unknown, where: string, filename: string): boolean {
    if (typeof v !== 'boolean') throw new Error(`${filename}: ${where} must be boolean`);
    return v;
}

function asRecord(v: unknown, where: string, filename: string): Record<string, unknown> {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        throw new Error(`${filename}: ${where} must be a mapping`);
    }
    return v as Record<string, unknown>;
}

function projectStringArray(
    v: unknown,
    where: string,
    filename?: string,
): string[] | undefined {
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
        throw new Error(`${filename ?? '<workflow>'}: ${where} must be an array of strings`);
    }
    return v as string[];
}
