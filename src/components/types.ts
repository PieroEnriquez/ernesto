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
 * bars that advance, an inputs-pending input that gets resolved). The
 * three input-shaped components always carry a slotId so a subscriber
 * can swap the prompt UI for the resolved value once the user responds.
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

export interface ChoiceInputProps {
    prompt: string;
    choices: { value: string; label: string; description?: string }[];
    multi?: boolean;
    defaults?: string[];
}

export interface TextInputProps {
    prompt: string;
    schema?: {
        type: 'string' | 'number' | 'boolean';
        format?: string;
        minLength?: number;
        maxLength?: number;
    };
    defaults?: unknown;
    multiline?: boolean;
}

export interface FormProps {
    prompt: string;
    fields: {
        id: string;
        label: string;
        type: 'string' | 'number' | 'boolean' | 'choice';
        required?: boolean;
        options?: string[];
    }[];
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
 * Discriminated union of all 15 components. The `kind` discriminator
 * narrows `props` to the matching `XxxProps`. Three input-shaped
 * components (`choice_input`, `text_input`, `form`) plus the four
 * updatable ones (`status`, `progress`, `thinking`, and the inputs)
 * carry an optional `slotId` for in-place update.
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
    | { kind: 'choice_input'; props: ChoiceInputProps; slotId?: string }
    | { kind: 'text_input'; props: TextInputProps; slotId?: string }
    | { kind: 'form'; props: FormProps; slotId?: string }
    | { kind: 'chart'; props: ChartProps }
    | { kind: 'tree'; props: TreeProps }
    | { kind: 'thinking'; props: ThinkingProps; slotId?: string };

/** All 15 component kinds — keep in sync with the {@link Component}
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
    'choice_input',
    'text_input',
    'form',
    'chart',
    'tree',
    'thinking',
] as const;

export type ComponentKind = (typeof COMPONENT_KINDS)[number];

/** Components whose emission pauses the run until a human responds.
 *  The UI tool handlers for these three call `HitlController.pauseForHuman`
 *  in addition to emitting `fact.component`. */
export type InputComponent = Extract<
    Component,
    { kind: 'choice_input' | 'text_input' | 'form' }
>;

const KIND_SET: ReadonlySet<string> = new Set(COMPONENT_KINDS);
const INPUT_KINDS: ReadonlySet<string> = new Set([
    'choice_input',
    'text_input',
    'form',
]);

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

/** Narrow a {@link Component} to the input subset (the three kinds that
 *  pause the run). */
export function isInputComponent(c: Component): c is InputComponent {
    return INPUT_KINDS.has(c.kind);
}
