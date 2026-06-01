/**
 * Component taxonomy — declarative UI intent emitted by agents/workflow
 * steps and consumed by per-transport subscribers (Slack, the mcp
 * transport's remote MCP client, the laptop transport, fragua-web).
 *
 * Two-level hierarchy:
 *
 * **Top-level ({@link UiComponent})** — 5 kinds the `ui([…])` MCP tool
 * accepts:
 *   - `thinking` — agent-internal trace (renderer-default rendered,
 *     not part of the uiTrail / answer contract).
 *   - `status` — side-band progress pill.
 *   - `progress` — side-band progress bar.
 *   - `attachment` — side-band file upload (workdir-relative path or
 *     external URL).
 *   - `hitl` — THE canonical answer per turn. Carries the contract for
 *     what comes next (`expect`, `resumePrompt`, `nextSteps`) plus the
 *     `render: RenderableComponent[]` payload the renderer surfaces.
 *
 * **Renderable ({@link RenderableComponent})** — 10 kinds that only
 * nest inside `hitl.props.render`. Cannot stand alone at the top-level.
 *   - `markdown` / `data-ref` / `file-link` / `table` / `metric` /
 *     `chart` / `code` / `image` / `link` / `tree`.
 *
 * `data-ref` and `file-link` are NEW vs. the prior single-union flavor:
 * the renderer materializes `data-ref` (workdir-relative file + view
 * DSL string) and renders `file-link` as a workdir-relative link.
 *
 * `slotId` is reserved for the side-band kinds (`status`, `progress`,
 * `thinking`) that may need in-place update across multiple emissions.
 */

// ─── Top-level: UiComponent ─────────────────────────────────────────

/** Agent's reasoning. Subscribers MAY surface this collapsed by
 *  default (a remote MCP client's "inner thoughts" pattern, Slack's
 *  collapsible block, the laptop transport's `chalk.gray`).
 *  Renderer-default rendered — not part of the uiTrail / canonical
 *  answer contract. */
export interface ThinkingComponent {
    kind: 'thinking';
    props: { text: string };
    slotId?: string;
}

/** Short status pill — update via `slotId` to walk one pill through
 *  stages instead of spawning a new one per stage. */
export interface StatusComponent {
    kind: 'status';
    props: {
        text: string;
        level?: 'info' | 'progress' | 'success' | 'warn' | 'error';
    };
    slotId?: string;
}

/** Progress bar — update via `slotId` as `current` advances. */
export interface ProgressComponent {
    kind: 'progress';
    props: {
        label: string;
        current: number;
        total: number;
    };
    slotId?: string;
}

/** File attachment. Carries either a workdir-relative `path` (for
 *  workspace-uploaded files) or an external `url`; at least one must
 *  be present. */
export interface AttachmentComponent {
    kind: 'attachment';
    props: {
        /** Workdir-relative path. Renderers that support upload (Slack
         *  `files.uploadV2`) read this from disk and upload as native. */
        path?: string;
        /** Alternative external URL. */
        url?: string;
        filename: string;
        mimeType?: string;
        caption?: string;
    };
}

/** The canonical answer per turn. Compound — its `render` field
 *  carries the {@link RenderableComponent}s the renderer surfaces;
 *  `expect`, `resumePrompt`, and `nextSteps` form the contract for the
 *  next turn. */
export interface HitlComponent {
    kind: 'hitl';
    props: {
        render: RenderableComponent[];
        expect: HitlExpect;
        resumePrompt: string;
        nextSteps?: NextStep[];
    };
}

/** Top-level component union — what the unified `ui` MCP tool
 *  accepts. */
export type UiComponent =
    | ThinkingComponent
    | StatusComponent
    | ProgressComponent
    | AttachmentComponent
    | HitlComponent;

/** Stable tuple of top-level kinds. */
export const UI_COMPONENT_KINDS = [
    'thinking',
    'status',
    'progress',
    'attachment',
    'hitl',
] as const;

export type UiComponentKind = (typeof UI_COMPONENT_KINDS)[number];

// ─── Expect (HITL contract) ─────────────────────────────────────────

/** What the agent expects in the next turn. */
export type HitlExpect =
    | { kind: 'message' }
    | { kind: 'choice'; schema: { enum: string[] }; defaults?: string }
    | { kind: 'form'; schema: Record<string, unknown>; defaults?: Record<string, unknown> }
    | { kind: 'none' };

/** Optional next-step hint — either a bare label string or a
 *  structured `{ id, label }` for renderers that want stable ids. */
export type NextStep = string | { id: string; label: string };

// ─── Renderable: per-kind props ─────────────────────────────────────

export interface MarkdownProps {
    body: string;
}

/** Workdir-relative data file + a view DSL string the renderer
 *  materializes (e.g. table view, chart view). */
export interface DataRefProps {
    file: string;
    view?: string;
    caption?: string;
}

/** Workdir-relative file link with optional label. */
export interface FileLinkProps {
    path: string;
    label?: string;
}

export interface TableColumn {
    id: string;
    label: string;
    align?: 'left' | 'right' | 'center';
}

export type TableRow = Record<string, string | number | boolean | null>;

export interface TableProps {
    columns: TableColumn[];
    rows: TableRow[];
    caption?: string;
}

export interface MetricDelta {
    value: number;
    direction: 'up' | 'down';
    period?: string;
}

export interface MetricProps {
    label: string;
    value: string | number;
    unit?: string;
    delta?: MetricDelta;
}

export interface ChartProps {
    series: { name: string; data: { x: unknown; y: number }[] }[];
    chartType: 'line' | 'bar' | 'pie' | 'scatter' | 'area';
    xLabel?: string;
    yLabel?: string;
    caption?: string;
}

export interface CodeProps {
    body: string;
    language: string;
    caption?: string;
}

export interface ImageProps {
    url: string;
    alt?: string;
    caption?: string;
}

export interface LinkProps {
    url: string;
    title: string;
    description?: string;
}

export interface TreeNode {
    label: string;
    value?: unknown;
    children?: TreeNode[];
}

export interface TreeProps {
    nodes: TreeNode[];
}

/** A single interactive button in an `actions` component. `actionId` is
 *  matched by the tier renderer's action handler (Slack `app.action`,
 *  etc.); `value` is the opaque payload handed back on click. */
export interface ActionButton {
    label: string;
    actionId: string;
    value?: unknown;
    style?: 'primary' | 'danger';
}

/** Props for the `actions` component — a row of interactive buttons.
 *  Unlike the other renderables (which project to inert text/image),
 *  `actions` is the one interactive renderable: the tier renderer
 *  surfaces real buttons and routes clicks to the matching `actionId`. */
export interface ActionsProps {
    buttons: ActionButton[];
}

/** Renderable component union — nested inside `hitl.props.render`. */
export type RenderableComponent =
    | { kind: 'markdown'; props: MarkdownProps }
    | { kind: 'data-ref'; props: DataRefProps }
    | { kind: 'file-link'; props: FileLinkProps }
    | { kind: 'table'; props: TableProps }
    | { kind: 'metric'; props: MetricProps }
    | { kind: 'chart'; props: ChartProps }
    | { kind: 'code'; props: CodeProps }
    | { kind: 'image'; props: ImageProps }
    | { kind: 'link'; props: LinkProps }
    | { kind: 'tree'; props: TreeProps }
    | { kind: 'actions'; props: ActionsProps };

/** Stable tuple of renderable kinds. */
export const RENDERABLE_COMPONENT_KINDS = [
    'markdown',
    'data-ref',
    'file-link',
    'table',
    'metric',
    'chart',
    'code',
    'image',
    'link',
    'tree',
    'actions',
] as const;

export type RenderableComponentKind = (typeof RENDERABLE_COMPONENT_KINDS)[number];
