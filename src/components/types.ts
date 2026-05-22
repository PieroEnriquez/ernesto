/**
 * Component taxonomy — declarative UI intent emitted by agents/workflow
 * steps and consumed by per-tier subscribers (Slack, claude.ai MCP,
 * CLI, fragua-web).
 *
 * This is the runtime extension of the dashboards `render:` annotation:
 * dashboards declare a single component kind per step at author time;
 * agent steps declare components dynamically at runtime via the `ui.*`
 * MCP tool surface (see {@link ../ui-tools}).
 *
 * Components are intentionally flat — no nesting. If a tier-specific
 * renderer wants a card-with-title-and-footer shape, it composes from
 * sibling components. Author-facing shape stays simple; renderer eats
 * the composition complexity.
 *
 * `slotId` lets an emitter target a previously-emitted component for
 * in-place update (status bars that progress through stages, progress
 * bars that advance, an input prompt that gets resolved). The single
 * `input` kind always carries a slotId so a subscriber can swap the
 * prompt UI for the resolved value once the user responds.
 */

/** Status pill — short progress signal. Update via `slotId` to walk
 *  through stages without spamming the channel. */
export interface StatusProps {
    text: string;
    level?: 'info' | 'progress' | 'success' | 'warn' | 'error';
}

/** Tabular data. Renderers MAY truncate large `rows` and emit a
 *  "open in thread" / virtualized affordance instead. */
export interface TableProps {
    columns: { id: string; label: string; align?: 'left' | 'right' | 'center' }[];
    rows: Record<string, unknown>[];
    caption?: string;
    footer?: { id: string; label: string; value: unknown }[];
}

/** Single KPI / metric with optional delta. */
export interface MetricProps {
    label: string;
    value: string | number;
    delta?: {
        value: number;
        direction: 'up' | 'down' | 'flat';
        period?: string;
    };
    unit?: string;
}

/** Free-form markdown. The renderer picks the dialect (Slack mrkdwn vs
 *  GitHub-flavoured vs ANSI). */
export interface MarkdownProps {
    body: string;
}

export interface ImageProps {
    url: string;
    alt?: string;
    width?: number;
    height?: number;
}

export interface CodeProps {
    language: string;
    body: string;
    filename?: string;
}

export interface LinkProps {
    url: string;
    label: string;
    icon?: string;
}

/** Attachment reference. `ref` is an attachments-yaml key or a URI the
 *  workspace's attachment provider understands. */
export interface AttachmentProps {
    ref: string;
    name?: string;
    mimeType?: string;
    sizeBytes?: number;
}

export interface ProgressProps {
    label: string;
    current: number;
    total: number;
    eta?: string;
}

/**
 * Unified input component — replaces the prior three variants
 * (`choice_input` / `text_input` / `form`). The JSON Schema describes
 * the expected input shape; the renderer inspects the schema to pick
 * the widget:
 *
 *   { type: 'string' }                          → text field
 *   { type: 'string', enum: [...] }             → buttons / radio / select
 *   { type: 'string', format: 'multiline' }     → textarea
 *   { type: 'number' }                          → number field
 *   { type: 'boolean' }                         → toggle
 *   { type: 'object', properties: { ... } }     → multi-field form
 *   { type: 'array', items: { ... } }           → repeating "add another"
 *
 * Nested objects/arrays render as nested forms / repeating sections.
 * `defaults` carries pre-filled values matching the schema shape.
 */
export interface InputProps {
    prompt: string;
    /** JSON Schema describing the expected input shape. The schema is
     *  the discriminator the renderer inspects to pick the widget. */
    schema: Record<string, unknown>;
    defaults?: unknown;
    /** Optional CTA label (Slack modal button, claude.ai accept-button,
     *  etc.). Renderers fall back to a tier-default label when absent. */
    submitLabel?: string;
}

export interface ChartProps {
    series: { name: string; data: { x: unknown; y: number }[] }[];
    chartType: 'line' | 'bar' | 'pie' | 'scatter' | 'area';
    xLabel?: string;
    yLabel?: string;
    caption?: string;
}

export interface TreeNode {
    label: string;
    value?: unknown;
    children?: TreeNode[];
}

export interface TreeProps {
    nodes: TreeNode[];
}

export interface ThinkingProps {
    /** Agent's reasoning. Subscribers MAY surface this collapsed by
     *  default (claude.ai's "inner thoughts" pattern). */
    text: string;
}

/**
 * Discriminated union of all 13 components. The `kind` discriminator
 * narrows `props` to the matching `XxxProps`. The `input` kind plus
 * the three updatable signals (`status`, `progress`, `thinking`) carry
 * an optional `slotId` for in-place update.
 */
export type Component =
    | { kind: 'status'; props: StatusProps; slotId?: string }
    | { kind: 'table'; props: TableProps }
    | { kind: 'metric'; props: MetricProps }
    | { kind: 'markdown'; props: MarkdownProps }
    | { kind: 'image'; props: ImageProps }
    | { kind: 'code'; props: CodeProps }
    | { kind: 'link'; props: LinkProps }
    | { kind: 'attachment'; props: AttachmentProps }
    | { kind: 'progress'; props: ProgressProps; slotId?: string }
    | { kind: 'input'; props: InputProps; slotId?: string }
    | { kind: 'chart'; props: ChartProps }
    | { kind: 'tree'; props: TreeProps }
    | { kind: 'thinking'; props: ThinkingProps; slotId?: string };

/** All 13 component kinds — keep in sync with the {@link Component}
 *  union above. Exported as a tuple so consumers can iterate at
 *  runtime (e.g. when registering one MCP tool per kind). */
export const COMPONENT_KINDS = [
    'status',
    'table',
    'metric',
    'markdown',
    'image',
    'code',
    'link',
    'attachment',
    'progress',
    'input',
    'chart',
    'tree',
    'thinking',
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** The input-shaped component — its emission pauses the run until a
 *  human responds. The UI tool handler for `ui.input` calls
 *  `HitlController.pauseForHuman` in addition to emitting
 *  `fact.component`. */
export type InputComponent = Extract<Component, { kind: 'input' }>;

const KIND_SET: ReadonlySet<string> = new Set(COMPONENT_KINDS);

/** Structural type guard. Validates the `kind` discriminator + that a
 *  `props` object exists; doesn't deep-validate the props payload
 *  (the per-tier renderer and the originating tool schema do that). */
export function isComponent(value: unknown): value is Component {
    if (!value || typeof value !== 'object') return false;
    const v = value as { kind?: unknown; props?: unknown };
    if (typeof v.kind !== 'string') return false;
    if (!KIND_SET.has(v.kind)) return false;
    if (!v.props || typeof v.props !== 'object') return false;
    return true;
}

/** Narrow a {@link Component} to the input subset (the kind that
 *  pauses the run). */
export function isInputComponent(c: Component): c is InputComponent {
    return c.kind === 'input';
}
