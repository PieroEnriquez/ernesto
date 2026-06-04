/**
 * Pure validators for {@link UiComponent} and {@link RenderableComponent}.
 *
 * Validators are structural — they check the `kind` discriminator, the
 * `props` shape, and required-field presence. They don't validate
 * renderer-specific concerns (URL well-formedness, chart-data
 * cardinality, etc.); per-transport renderers do that.
 *
 * Errors are descriptive strings the wire layer can surface to the
 * agent. Each error follows the format
 * `"<violation>. Received <observed>. Try: <recovery shape>"`
 * so an LLM scanning the message has the recovery shape on the same
 * line — observed live-MITM showed agents retrying faster when the
 * recovery shape is colocated with the violation.
 *
 * Most kinds are described by a declarative field-spec table
 * ({@link SPECS}) driving a single {@link validateFlatFields}. The
 * irregular shapes — `hitl` (nested arrays of renderables + `expect` +
 * `nextSteps`), `attachment` (path|url either-or), and the nested-array
 * renderables `table`/`chart`/`tree`/`metric.delta` — keep a bespoke
 * validator layered on top; the table can't express those cleanly.
 */

import type {
    UiComponent,
    ThinkingComponent,
    StatusComponent,
    ProgressComponent,
    AttachmentComponent,
    HitlComponent,
    RenderableComponent,
    HitlExpect,
    NextStep,
    UiComponentKind,
    RenderableComponentKind,
} from './types';
import {
    UI_COMPONENT_KINDS,
    RENDERABLE_COMPONENT_KINDS,
} from './types';

export type ValidationResult<T> =
    | { ok: true; value: T }
    | { ok: false; error: string };

const UI_KINDS: ReadonlySet<string> = new Set(UI_COMPONENT_KINDS);
const RENDERABLE_KINDS: ReadonlySet<string> = new Set(RENDERABLE_COMPONENT_KINDS);
const STATUS_LEVEL_SET: ReadonlySet<string> = new Set([
    'info',
    'progress',
    'success',
    'warn',
    'error',
]);
const CHART_TYPE_SET: ReadonlySet<string> = new Set([
    'line',
    'bar',
    'pie',
    'scatter',
    'area',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.length > 0;
}

function err<T>(message: string): ValidationResult<T> {
    return { ok: false, error: message };
}

function ok<T>(value: T): ValidationResult<T> {
    return { ok: true, value };
}

/** Compact JS-typeof label for the `Received <type>` segment. Arrays
 *  surface as `array`, plain objects as `object`, `null` as `null`. */
function typeLabel(v: unknown): string {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
}

// ─── Field-spec model ───────────────────────────────────────────────
//
// Each flat field is a terse `[name, type, tail]` tuple. The `type`
// code derives both the `check` predicate and the `<constraint>`
// fragment of the error; `tail` is the unique `Try:` recovery snippet
// colocated with the violation. Optional fields use the `'…?'` codes
// and are skipped (and dropped from the output) when absent.

/** Field type codes → [predicate, constraint fragment]. */
const FIELD_TYPES = {
    /** required string */
    str: [(v: unknown) => typeof v === 'string', 'must be a string'],
    /** required non-empty string */
    nes: [(v: unknown) => isNonEmptyString(v), 'must be a non-empty string'],
    /** required finite number */
    num: [
        (v: unknown) => typeof v === 'number' && Number.isFinite(v),
        'must be a finite number',
    ],
    /** required string-or-number */
    strnum: [
        (v: unknown) => typeof v === 'string' || typeof v === 'number',
        'must be a string or number',
    ],
    /** optional string (validated only when present) */
    'str?': [(v: unknown) => typeof v === 'string', 'must be a string when present'],
    /** status level enum */
    level: [
        (v: unknown) => typeof v === 'string' && STATUS_LEVEL_SET.has(v),
        'must be one of: info, progress, success, warn, error',
    ],
} as const satisfies Record<string, readonly [(v: unknown) => boolean, string]>;

type FieldType = keyof typeof FIELD_TYPES;
/** `[propName, typeCode, tailSnippet]`. */
type FieldSpec = readonly [string, FieldType, string];

interface KindSpec {
    /** Head shown when `props` itself isn't an object:
     *  `"<kind>.props must be {<propsHint>}. …"`. */
    propsHint: string;
    /** Full mini-example for the no-props `Try:` tail. */
    example: string;
    /** Ordered flat fields (first failure wins). Nested-shape kinds
     *  (table/chart/tree/metric.delta) leave this short and layer a
     *  bespoke validator on top. */
    fields: readonly FieldSpec[];
}

const OPTIONAL: ReadonlySet<FieldType> = new Set(['str?', 'level']);

/**
 * Declarative shapes for every flat kind (top-level + renderable). The
 * irregular ones — `table`/`chart`/`tree` (nested arrays) and
 * `metric` (nested `delta`) — carry only their flat fields here and run
 * a bespoke validator after the flat pass.
 */
const SPECS: Record<string, KindSpec> = {
    thinking: {
        propsHint: 'text: string',
        example: "{ kind: 'thinking', props: { text: '…' } }",
        fields: [['text', 'nes', "{ kind: 'thinking', props: { text: '…' } }"]],
    },
    status: {
        propsHint: 'text: string, level?',
        example: "{ kind: 'status', props: { text: '…' } }",
        fields: [
            ['text', 'nes', "{ kind: 'status', props: { text: '…' } }"],
            ['level', 'level', "{ kind: 'status', props: { text: '…', level: 'progress' } }"],
        ],
    },
    progress: {
        propsHint: 'label, current, total',
        example: "{ kind: 'progress', props: { label: '…', current: 3, total: 10 } }",
        fields: [
            ['label', 'nes', "{ kind: 'progress', props: { label: '…', current: 3, total: 10 } }"],
            ['current', 'num', 'current: 3 (integer)'],
            ['total', 'num', 'total: 10 (integer)'],
        ],
    },
    markdown: {
        propsHint: 'body: string',
        example: "{ kind: 'markdown', props: { body: '…' } }",
        fields: [['body', 'str', "{ kind: 'markdown', props: { body: '…' } }"]],
    },
    'data-ref': {
        propsHint: 'file: string, view?, caption?',
        example: "{ kind: 'data-ref', props: { file: 'r.json', view: 'auto' } }",
        fields: [
            ['file', 'nes', "{ kind: 'data-ref', props: { file: 'r.json', view: 'auto' } }"],
            ['view', 'str?', "view: 'auto' (or 'table:byField' | 'metric:byField' | 'chart:…')"],
            ['caption', 'str?', "caption: '…'"],
        ],
    },
    'file-link': {
        propsHint: 'path: string, label?',
        example: "{ kind: 'file-link', props: { path: 'doc.md', label: 'Open' } }",
        fields: [
            ['path', 'nes', "{ kind: 'file-link', props: { path: 'doc.md', label: 'Open' } }"],
            ['label', 'str?', "label: 'Open'"],
        ],
    },
    table: {
        propsHint: 'columns: [{id, label}], rows: [...], caption?',
        example:
            "{ kind: 'table', props: { columns: [{id:'region',label:'Region'}], rows: [...] } }",
        fields: [],
    },
    metric: {
        propsHint: 'label: string, value, unit?, delta?',
        example: "{ kind: 'metric', props: { label: 'Orders', value: 42 } }",
        fields: [
            ['label', 'nes', "{ kind: 'metric', props: { label: 'Orders', value: 42 } }"],
            ['value', 'strnum', "value: 42 (or '$1,200')"],
            ['unit', 'str?', "unit: 'orders'"],
        ],
    },
    chart: {
        propsHint: 'series, chartType',
        example: "{ kind: 'chart', props: { series: [...], chartType: 'bar' } }",
        fields: [],
    },
    code: {
        propsHint: 'body: string, language: string, caption?',
        example: "{ kind: 'code', props: { body: '…', language: 'ts' } }",
        fields: [
            ['body', 'str', "{ kind: 'code', props: { body: '…', language: 'ts' } }"],
            ['language', 'nes', "language: 'ts' (or 'sql', 'sh', …)"],
            ['caption', 'str?', "caption: 'snippet'"],
        ],
    },
    image: {
        propsHint: 'url: string, alt?, caption?',
        example: "{ kind: 'image', props: { url: 'https://…/x.png' } }",
        fields: [
            ['url', 'nes', "{ kind: 'image', props: { url: 'https://…/x.png' } }"],
            ['alt', 'str?', "alt: 'Daily revenue chart'"],
            ['caption', 'str?', "caption: '…'"],
        ],
    },
    link: {
        propsHint: 'url: string, title: string, description?',
        example: "{ kind: 'link', props: { url: 'https://…', title: '…' } }",
        fields: [
            ['url', 'nes', "{ kind: 'link', props: { url: 'https://…', title: '…' } }"],
            ['title', 'nes', "title: 'Open dashboard'"],
            ['description', 'str?', "description: '…'"],
        ],
    },
    tree: {
        propsHint: 'nodes: [...]',
        example: "{ kind: 'tree', props: { nodes: [{ label: 'root' }] } }",
        fields: [],
    },
};

/** Build the `"<kind>.props.<name> …"` violation for a failed field. */
function fieldError(kind: string, field: FieldSpec, value: unknown): string {
    const [name, type, tail] = field;
    const constraint = FIELD_TYPES[type][1];
    return (
        `${kind}.props.${name} ${constraint}. ` +
        `Received ${typeLabel(value)}. ` +
        `Try: ${tail}`
    );
}

/**
 * Validate the flat fields of a kind's props against {@link SPECS}.
 * Returns the first violation, or `null` when all flat fields pass. The
 * caller (renderable/top-level dispatchers) layers any bespoke
 * `extra` checks (nested arrays, either-or) on top.
 */
function validateFlatFields(
    kind: string,
    props: Record<string, unknown>,
): string | null {
    for (const field of SPECS[kind].fields) {
        const [name, type] = field;
        const value = props[name];
        if (OPTIONAL.has(type) && value === undefined) continue;
        if (!FIELD_TYPES[type][0](value)) {
            return fieldError(kind, field, value);
        }
    }
    return null;
}

/** Copy only the spec'd flat fields that are present onto an output
 *  object (drops unknown keys; keeps optional ones when set). */
function pickFlatFields(
    kind: string,
    props: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name] of SPECS[kind].fields) {
        const value = props[name];
        if (value === undefined) continue;
        out[name] = value;
    }
    return out;
}

// ─── Top-level dispatcher ────────────────────────────────────────────

/** Validate any top-level UI component. */
export function validateUiComponent(
    value: unknown,
): ValidationResult<UiComponent> {
    if (!isPlainObject(value)) {
        return err(
            `component must be an object. Received ${typeLabel(value)}. ` +
                `Try: { kind: 'thinking'|'status'|'progress'|'attachment'|'hitl', props: {…} }`,
        );
    }
    const kind = value.kind;
    if (typeof kind !== 'string') {
        return err(
            `component.kind must be a string. Received ${typeLabel(kind)}. ` +
                `Try: kind: 'hitl' (one of: ${UI_COMPONENT_KINDS.join(', ')})`,
        );
    }
    if (!UI_KINDS.has(kind)) {
        return err(
            `component.kind '${kind}' is not a top-level UiComponent kind. ` +
                `Try: one of ${UI_COMPONENT_KINDS.join(', ')}`,
        );
    }
    switch (kind as UiComponentKind) {
        case 'thinking':
            return validateThinking(value);
        case 'status':
            return validateStatus(value);
        case 'progress':
            return validateProgress(value);
        case 'attachment':
            return validateAttachment(value);
        case 'hitl':
            return validateHitl(value);
    }
}

/**
 * Collect-all variant of {@link validateUiComponent}. Returns ALL
 * field-level errors found in the component instead of the first one.
 *
 * The single-error path ({@link validateUiComponent}) bails on the
 * first failure — fine for happy-path coercion, but agents emitting a
 * large `hitl` with N broken renderables would otherwise burn N
 * round-trips fixing one field at a time. This variant unrolls
 * `hitl.props.render[]`, `hitl.props.nextSteps[]`, and the top-level
 * required fields so the agent can see the full diagnostic set in one
 * tool-result.
 *
 * Returns an empty array when the component validates cleanly. Each
 * error string is already path-prefixed (e.g.
 * `"hitl.props.render[8]: chart.props.series must be an array …"`).
 */
export function collectUiComponentErrors(value: unknown): string[] {
    if (!isPlainObject(value)) {
        return [
            `component must be an object. Received ${typeLabel(value)}. ` +
                `Try: { kind: 'thinking'|'status'|'progress'|'attachment'|'hitl', props: {…} }`,
        ];
    }
    const kind = value.kind;
    if (typeof kind !== 'string') {
        return [
            `component.kind must be a string. Received ${typeLabel(kind)}. ` +
                `Try: kind: 'hitl' (one of: ${UI_COMPONENT_KINDS.join(', ')})`,
        ];
    }
    if (!UI_KINDS.has(kind)) {
        return [
            `component.kind '${kind}' is not a top-level UiComponent kind. ` +
                `Try: one of ${UI_COMPONENT_KINDS.join(', ')}`,
        ];
    }
    // For non-hitl kinds the single-error path is already exhaustive
    // (props are flat, no nested arrays-of-renderables to unroll).
    if (kind !== 'hitl') {
        const result = validateUiComponent(value);
        return result.ok ? [] : [result.error];
    }
    return collectHitlErrors(value);
}

function collectHitlErrors(value: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const props = value.props;
    if (!isPlainObject(props)) {
        return [
            `hitl.props must be {render, expect, resumePrompt, nextSteps?}. ` +
                `Received ${typeLabel(props)}. ` +
                "Try: props: { render: [...], expect: {kind:'message'}, resumePrompt: '…' }",
        ];
    }
    if (!Array.isArray(props.render)) {
        errors.push(
            `hitl.props.render must be an array of RenderableComponent. ` +
                `Received ${typeLabel(props.render)}. ` +
                "Try: render: [{ kind: 'markdown', props: { body: '…' } }]",
        );
    } else {
        for (let i = 0; i < props.render.length; i++) {
            const sub = validateRenderableComponent(props.render[i]);
            if (!sub.ok) {
                errors.push(`hitl.props.render[${i}]: ${sub.error}`);
            }
        }
    }
    const expectResult = validateHitlExpect(props.expect);
    if (!expectResult.ok) {
        errors.push(`hitl.props.expect: ${expectResult.error}`);
    }
    if (!isNonEmptyString(props.resumePrompt)) {
        errors.push(
            "hitl.props.resumePrompt is required (a template like 'User said: {value}.' is fine). " +
                "Don't omit it; the engine uses it to materialize the next turn's prompt. " +
                `Received ${typeLabel(props.resumePrompt)}.`,
        );
    }
    if (props.nextSteps !== undefined) {
        if (!Array.isArray(props.nextSteps)) {
            errors.push(
                `hitl.props.nextSteps must be an array when present. ` +
                    `Received ${typeLabel(props.nextSteps)}. ` +
                    "Try: nextSteps: ['retry', { id: 'go', label: 'Go' }]",
            );
        } else {
            for (let i = 0; i < props.nextSteps.length; i++) {
                const stepResult = validateNextStep(props.nextSteps[i]);
                if (!stepResult.ok) {
                    errors.push(
                        `hitl.props.nextSteps[${i}]: ${stepResult.error}`,
                    );
                }
            }
        }
    }
    return errors;
}

// ─── Per-kind top-level validators ──────────────────────────────────

export function validateThinking(
    value: unknown,
): ValidationResult<ThinkingComponent> {
    if (!isPlainObject(value) || value.kind !== 'thinking') {
        return err(
            "expected component with kind: 'thinking'. " +
                "Try: { kind: 'thinking', props: { text: '…' } }",
        );
    }
    const props = value.props;
    if (!isPlainObject(props)) {
        return err(
            `thinking.props must be {${SPECS.thinking.propsHint}}. Received ${typeLabel(props)}. ` +
                "Try: { kind: 'thinking', props: { text: '…' } }",
        );
    }
    const flat = validateFlatFields('thinking', props);
    if (flat) return err(flat);
    const out: ThinkingComponent = {
        kind: 'thinking',
        props: { text: props.text as string },
    };
    if (typeof value.slotId === 'string') out.slotId = value.slotId;
    return ok(out);
}

export function validateStatus(
    value: unknown,
): ValidationResult<StatusComponent> {
    if (!isPlainObject(value) || value.kind !== 'status') {
        return err(
            "expected component with kind: 'status'. " +
                "Try: { kind: 'status', props: { text: '…', level?: 'info'|'progress'|'success'|'warn'|'error' } }",
        );
    }
    const props = value.props;
    if (!isPlainObject(props)) {
        return err(
            `status.props must be {${SPECS.status.propsHint}}. Received ${typeLabel(props)}. ` +
                "Try: { kind: 'status', props: { text: '…' } }",
        );
    }
    const flat = validateFlatFields('status', props);
    if (flat) return err(flat);
    const level = props.level as StatusComponent['props']['level'] | undefined;
    const out: StatusComponent = {
        kind: 'status',
        props: level === undefined
            ? { text: props.text as string }
            : { text: props.text as string, level },
    };
    if (typeof value.slotId === 'string') out.slotId = value.slotId;
    return ok(out);
}

export function validateProgress(
    value: unknown,
): ValidationResult<ProgressComponent> {
    if (!isPlainObject(value) || value.kind !== 'progress') {
        return err(
            "expected component with kind: 'progress'. " +
                "Try: { kind: 'progress', props: { label: '…', current: 3, total: 10 } }",
        );
    }
    const props = value.props;
    if (!isPlainObject(props)) {
        return err(
            `progress.props must be {${SPECS.progress.propsHint}}. Received ${typeLabel(props)}. ` +
                "Try: { kind: 'progress', props: { label: '…', current: 3, total: 10 } }",
        );
    }
    const flat = validateFlatFields('progress', props);
    if (flat) return err(flat);
    const out: ProgressComponent = {
        kind: 'progress',
        props: {
            label: props.label as string,
            current: props.current as number,
            total: props.total as number,
        },
    };
    if (typeof value.slotId === 'string') out.slotId = value.slotId;
    return ok(out);
}

export function validateAttachment(
    value: unknown,
): ValidationResult<AttachmentComponent> {
    if (!isPlainObject(value) || value.kind !== 'attachment') {
        return err(
            "expected component with kind: 'attachment'. " +
                "Try: { kind: 'attachment', props: { filename: '…', path|url: '…' } }",
        );
    }
    const props = value.props;
    if (!isPlainObject(props)) {
        return err(
            `attachment.props must be {filename, path|url, mimeType?, caption?}. ` +
                `Received ${typeLabel(props)}. ` +
                "Try: { kind: 'attachment', props: { filename: 'r.json', path: '_results/r.json' } }",
        );
    }
    if (!isNonEmptyString(props.filename)) {
        return err(
            `attachment.props.filename must be a non-empty string. Received ${typeLabel(props.filename)}. ` +
                "Try: filename: 'report.json'",
        );
    }
    const hasPath = typeof props.path === 'string' && props.path.length > 0;
    const hasUrl = typeof props.url === 'string' && props.url.length > 0;
    if (!hasPath && !hasUrl) {
        return err(
            "attachment.props requires at least one of: path, url. " +
                "Try: props: { filename: '…', path: '_results/r.json' } " +
                "or props: { filename: '…', url: 'https://…' }",
        );
    }
    if (props.mimeType !== undefined && typeof props.mimeType !== 'string') {
        return err(
            `attachment.props.mimeType must be a string. Received ${typeLabel(props.mimeType)}. ` +
                "Try: mimeType: 'application/json'",
        );
    }
    if (props.caption !== undefined && typeof props.caption !== 'string') {
        return err(
            `attachment.props.caption must be a string. Received ${typeLabel(props.caption)}. ` +
                "Try: caption: 'Daily report'",
        );
    }
    const outProps: AttachmentComponent['props'] = { filename: props.filename };
    if (hasPath) outProps.path = props.path as string;
    if (hasUrl) outProps.url = props.url as string;
    if (typeof props.mimeType === 'string') outProps.mimeType = props.mimeType;
    if (typeof props.caption === 'string') outProps.caption = props.caption;
    return ok({ kind: 'attachment', props: outProps });
}

export function validateHitl(
    value: unknown,
): ValidationResult<HitlComponent> {
    if (!isPlainObject(value) || value.kind !== 'hitl') {
        return err(
            "expected component with kind: 'hitl'. " +
                "Try: { kind: 'hitl', props: { render: [...], expect: {kind:'message'}, resumePrompt: '…' } }",
        );
    }
    const props = value.props;
    if (!isPlainObject(props)) {
        return err(
            `hitl.props must be {render, expect, resumePrompt, nextSteps?}. ` +
                `Received ${typeLabel(props)}. ` +
                "Try: props: { render: [...], expect: {kind:'message'}, resumePrompt: '…' }",
        );
    }
    if (!Array.isArray(props.render)) {
        return err(
            `hitl.props.render must be an array of RenderableComponent. ` +
                `Received ${typeLabel(props.render)}. ` +
                "Try: render: [{ kind: 'markdown', props: { body: '…' } }]",
        );
    }
    const render: RenderableComponent[] = [];
    for (let i = 0; i < props.render.length; i++) {
        const sub = validateRenderableComponent(props.render[i]);
        if (!sub.ok) {
            return err(`hitl.props.render[${i}]: ${sub.error}`);
        }
        render.push(sub.value);
    }
    const expectResult = validateHitlExpect(props.expect);
    if (!expectResult.ok) {
        return err(`hitl.props.expect: ${expectResult.error}`);
    }
    if (!isNonEmptyString(props.resumePrompt)) {
        return err(
            "hitl.props.resumePrompt is required (a template like 'User said: {value}.' is fine). " +
                "Don't omit it; the engine uses it to materialize the next turn's prompt. " +
                `Received ${typeLabel(props.resumePrompt)}.`,
        );
    }
    let nextSteps: NextStep[] | undefined;
    if (props.nextSteps !== undefined) {
        if (!Array.isArray(props.nextSteps)) {
            return err(
                `hitl.props.nextSteps must be an array when present. ` +
                    `Received ${typeLabel(props.nextSteps)}. ` +
                    "Try: nextSteps: ['retry', { id: 'go', label: 'Go' }]",
            );
        }
        nextSteps = [];
        for (let i = 0; i < props.nextSteps.length; i++) {
            const stepResult = validateNextStep(props.nextSteps[i]);
            if (!stepResult.ok) {
                return err(`hitl.props.nextSteps[${i}]: ${stepResult.error}`);
            }
            nextSteps.push(stepResult.value);
        }
    }
    const out: HitlComponent = {
        kind: 'hitl',
        props: nextSteps === undefined
            ? {
                  render,
                  expect: expectResult.value,
                  resumePrompt: props.resumePrompt,
              }
            : {
                  render,
                  expect: expectResult.value,
                  resumePrompt: props.resumePrompt,
                  nextSteps,
              },
    };
    return ok(out);
}

function validateHitlExpect(value: unknown): ValidationResult<HitlExpect> {
    if (!isPlainObject(value)) {
        return err(
            `expect must be an object. Received ${typeLabel(value)}. ` +
                "Try: expect: { kind: 'message' } (or 'choice'|'form'|'none')",
        );
    }
    const kind = value.kind;
    if (kind === 'message' || kind === 'none') {
        return ok({ kind });
    }
    if (kind === 'choice') {
        const schema = value.schema;
        if (!isPlainObject(schema) || !Array.isArray(schema.enum)) {
            return err(
                `expect.schema.enum must be an array for kind 'choice'. ` +
                    `Received schema=${typeLabel(schema)}. ` +
                    "Try: expect: { kind: 'choice', schema: { enum: ['approve', 'reject'] } }",
            );
        }
        for (const e of schema.enum) {
            if (typeof e !== 'string') {
                return err(
                    `expect.schema.enum entries must be strings. Received entry of type ${typeLabel(e)}. ` +
                        "Try: enum: ['approve', 'reject']",
                );
            }
        }
        const out: HitlExpect = {
            kind: 'choice',
            schema: { enum: schema.enum as string[] },
        };
        if (typeof value.defaults === 'string') out.defaults = value.defaults;
        return ok(out);
    }
    if (kind === 'form') {
        const schema = value.schema;
        if (!isPlainObject(schema)) {
            return err(
                `expect.schema must be an object for kind 'form'. Received ${typeLabel(schema)}. ` +
                    "Try: expect: { kind: 'form', schema: { type: 'object', properties: {…} } }",
            );
        }
        const out: HitlExpect = { kind: 'form', schema };
        if (isPlainObject(value.defaults)) {
            out.defaults = value.defaults;
        }
        return ok(out);
    }
    return err(
        `expect.kind '${String(kind)}' is not one of: message, choice, form, none. ` +
            "Try: expect: { kind: 'message' }",
    );
}

function validateNextStep(value: unknown): ValidationResult<NextStep> {
    if (typeof value === 'string') {
        if (value.length === 0) {
            return err(
                "nextStep string must be non-empty. " +
                    "Try: 'retry' or { id: 'retry', label: 'Retry' }",
            );
        }
        return ok(value);
    }
    if (isPlainObject(value)) {
        if (!isNonEmptyString(value.id)) {
            return err(
                `nextStep.id must be a non-empty string. Received ${typeLabel(value.id)}. ` +
                    "Try: { id: 'retry', label: 'Retry' }",
            );
        }
        if (!isNonEmptyString(value.label)) {
            return err(
                `nextStep.label must be a non-empty string. Received ${typeLabel(value.label)}. ` +
                    "Try: { id: 'retry', label: 'Retry' }",
            );
        }
        return ok({ id: value.id, label: value.label });
    }
    return err(
        `nextStep must be a string or { id, label } object. Received ${typeLabel(value)}. ` +
            "Try: 'retry' or { id: 'retry', label: 'Retry' }",
    );
}

// ─── Renderable validators ──────────────────────────────────────────

/** Validate any renderable component (the kinds nested inside
 *  `hitl.props.render`). */
export function validateRenderableComponent(
    value: unknown,
): ValidationResult<RenderableComponent> {
    if (!isPlainObject(value)) {
        return err(
            `renderable must be an object. Received ${typeLabel(value)}. ` +
                "Try: { kind: 'markdown', props: { body: '…' } }",
        );
    }
    const kind = value.kind;
    if (typeof kind !== 'string') {
        return err(
            `renderable.kind must be a string. Received ${typeLabel(kind)}. ` +
                `Try: one of ${RENDERABLE_COMPONENT_KINDS.join(', ')}`,
        );
    }
    if (!RENDERABLE_KINDS.has(kind)) {
        return err(
            `renderable.kind '${kind}' is not a RenderableComponent kind. ` +
                `Try: one of ${RENDERABLE_COMPONENT_KINDS.join(', ')}`,
        );
    }
    const rKind = kind as RenderableComponentKind;
    const spec = SPECS[rKind];
    const props = value.props;
    if (!isPlainObject(props)) {
        return err(
            `${kind}.props must be {${spec.propsHint}}. ` +
                `Received ${typeLabel(props)}. ` +
                `Try: ${spec.example}`,
        );
    }
    // Flat-field pass (table/chart/tree have no flat fields; their
    // nested-array shapes are validated bespoke below).
    const flat = validateFlatFields(rKind, props);
    if (flat) return err(flat);

    switch (rKind) {
        case 'table':
            return validateTable(props);
        case 'metric':
            return validateMetric(props);
        case 'chart':
            return validateChart(props);
        case 'tree':
            return validateTree(props);
        default:
            // Flat kinds: markdown, data-ref, file-link, code, image,
            // link — output carries only the spec'd present fields.
            return ok({
                kind: rKind,
                props: pickFlatFields(rKind, props),
            } as unknown as RenderableComponent);
    }
}

function validateTable(
    props: Record<string, unknown>,
): ValidationResult<RenderableComponent> {
    if (!Array.isArray(props.columns)) {
        return err(
            `table.props.columns must be an array of {id, label}. Received ${typeLabel(props.columns)}. ` +
                "Try: columns: [{id: 'region', label: 'Region'}, {id: 'gmv', label: 'GMV'}]",
        );
    }
    for (let i = 0; i < props.columns.length; i++) {
        const col = props.columns[i];
        if (!isPlainObject(col)) {
            return err(
                `table.props.columns[${i}] must be {id: string, label: string}. ` +
                    `Received ${typeLabel(col)}. ` +
                    "Try: [{id: 'region', label: 'Region'}, …]",
            );
        }
        if (!isNonEmptyString(col.id)) {
            return err(
                `table.props.columns[${i}].id must be a non-empty string. ` +
                    `Received ${typeLabel(col.id)}. ` +
                    "Try: {id: 'region', label: 'Region'}",
            );
        }
        if (!isNonEmptyString(col.label)) {
            return err(
                `table.props.columns[${i}].label must be a non-empty string. ` +
                    `Received ${typeLabel(col.label)}. ` +
                    "Try: {id: 'region', label: 'Region'}",
            );
        }
        if (
            col.align !== undefined &&
            col.align !== 'left' &&
            col.align !== 'right' &&
            col.align !== 'center'
        ) {
            return err(
                `table.props.columns[${i}].align must be one of: left, right, center. ` +
                    `Received ${typeLabel(col.align)}. ` +
                    "Try: align: 'right'",
            );
        }
    }
    if (!Array.isArray(props.rows)) {
        return err(
            `table.props.rows must be an array. Received ${typeLabel(props.rows)}. ` +
                "Try: rows: [{ region: 'EU', gmv: 1200 }, …]",
        );
    }
    return ok({
        kind: 'table',
        props: props as unknown as import('./types').TableProps,
    });
}

function validateMetric(
    props: Record<string, unknown>,
): ValidationResult<RenderableComponent> {
    // label / value / unit validated by the flat-field pass; only the
    // nested `delta` shape is bespoke.
    if (props.delta !== undefined) {
        if (!isPlainObject(props.delta)) {
            return err(
                `metric.props.delta must be {value: number, direction: 'up'|'down'}. ` +
                    `Received ${typeLabel(props.delta)}. ` +
                    "Try: delta: { value: 0.12, direction: 'up' }",
            );
        }
        if (typeof props.delta.value !== 'number') {
            return err(
                `metric.props.delta.value must be a number. Received ${typeLabel(props.delta.value)}. ` +
                    "Try: delta: { value: 0.12, direction: 'up' }",
            );
        }
        if (props.delta.direction !== 'up' && props.delta.direction !== 'down') {
            return err(
                `metric.props.delta.direction must be 'up' or 'down'. ` +
                    `Received ${typeLabel(props.delta.direction)}. ` +
                    "Try: delta: { value: 0.12, direction: 'up' }",
            );
        }
    }
    return ok({
        kind: 'metric',
        props: props as unknown as import('./types').MetricProps,
    });
}

function validateChart(
    props: Record<string, unknown>,
): ValidationResult<RenderableComponent> {
    if (!Array.isArray(props.series)) {
        return err(
            `chart.props.series must be an array. Received ${typeLabel(props.series)}. ` +
                "Try: series: [{ name: 'EU', data: [{x: 'Mon', y: 12}, …] }]",
        );
    }
    if (typeof props.chartType !== 'string' || !CHART_TYPE_SET.has(props.chartType)) {
        return err(
            `chart.props.chartType must be one of: line, bar, pie, scatter, area. ` +
                `Received ${typeLabel(props.chartType)}. ` +
                "Try: chartType: 'bar'",
        );
    }
    return ok({
        kind: 'chart',
        props: props as unknown as import('./types').ChartProps,
    });
}

function validateTree(
    props: Record<string, unknown>,
): ValidationResult<RenderableComponent> {
    if (!Array.isArray(props.nodes)) {
        return err(
            `tree.props.nodes must be an array. Received ${typeLabel(props.nodes)}. ` +
                "Try: nodes: [{ label: 'root', children: [{ label: 'child' }] }]",
        );
    }
    return ok({
        kind: 'tree',
        props: props as unknown as import('./types').TreeProps,
    });
}
