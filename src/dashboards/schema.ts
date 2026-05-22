/**
 * `.dashboard.md` spec schema — single source of truth for both the
 * admin-panel runtime renderer and any server-side consumer (settle-time
 * lint, Slack snapshots, PDF export, the `dashboard-author` managed
 * agent's self-validation).
 *
 * Block kinds:
 *   - `metric-row` / `timeseries` / `table` — SQL fetched against Redshift
 *   - `markdown` — prose, no data
 *   - `js` — derived in the browser from upstream block results. The
 *     `as:` field picks the visual variant (`metric-row` | `timeseries`
 *     | `table`) and the rendering config matches that variant.
 *
 * Filters are date-range or multi/single-select with hardcoded options.
 * See `workspaces/marketing/dashboards-plan/02-spec-language.md` for the
 * full reference.
 */

import { z } from 'zod';

export const SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;
export const BLOCK_ID_RE = /^[a-z][a-zA-Z0-9_]{0,63}$/;

export const FORMAT_VALUES = [
    'eur',
    'usd',
    'int',
    'float',
    'pct',
    'ratio',
    'text',
    'date',
    'datetime',
] as const;
export type Format = (typeof FORMAT_VALUES)[number];

export const formatSchema = z.enum(FORMAT_VALUES);

// ─── Filters ────────────────────────────────────────────────────────────────

const DATE_RANGE_DEFAULTS = [
    'last_7d',
    'last_30d',
    'last_90d',
    'last_180d',
    'last_365d',
    'ytd',
] as const;
export type DateRangeDefault = (typeof DATE_RANGE_DEFAULTS)[number];

const bindsMap = z.record(z.string(), z.string());

const dateRangeFilter = z.object({
    id: z.string(),
    kind: z.literal('date-range'),
    default: z.enum(DATE_RANGE_DEFAULTS).default('last_90d'),
    label: z.string().optional(),
    binds: bindsMap,
});

const multiSelectFilter = z.object({
    id: z.string(),
    kind: z.literal('multi-select'),
    label: z.string().optional(),
    options: z.array(z.string()).min(1),
    binds: bindsMap,
    required: z.boolean().optional(),
});

const singleSelectFilter = z.object({
    id: z.string(),
    kind: z.literal('single-select'),
    label: z.string().optional(),
    options: z.array(z.string()).min(1),
    default: z.string().optional(),
    binds: bindsMap,
    required: z.boolean().optional(),
});

export const filterSchema = z.discriminatedUnion('kind', [
    dateRangeFilter,
    multiSelectFilter,
    singleSelectFilter,
]);
export type Filter = z.infer<typeof filterSchema>;

// ─── Block sub-schemas (shared between SQL and JS variants) ────────────────

const metricsSchema = z
    .array(
        z.object({
            col: z.string().min(1),
            label: z.string().min(1),
            format: formatSchema.default('int'),
        }),
    )
    .min(1)
    .max(6);

const chartConfigSchema = z
    .object({
        type: z.enum(['line', 'area', 'column', 'spline']).default('line'),
        yLabel: z.string().optional(),
        stacked: z.boolean().default(false),
        yFormat: formatSchema.default('float'),
    })
    .default(() => ({ type: 'line' as const, stacked: false, yFormat: 'float' as const }));

const columnsSchema = z
    .array(
        z.object({
            col: z.string().min(1),
            label: z.string().min(1),
            format: formatSchema.default('text'),
            sortable: z.boolean().optional(),
            align: z.enum(['left', 'right', 'center']).optional(),
            width: z.number().int().positive().optional(),
        }),
    )
    .min(1);

const blockBase = z.object({
    id: z.string().regex(BLOCK_ID_RE),
    title: z.string().optional(),
    description: z.string().optional(),
});

// ─── SQL-backed block variants ─────────────────────────────────────────────

const metricRowBlock = blockBase.extend({
    kind: z.literal('metric-row'),
    sql: z.string().min(1),
    metrics: metricsSchema,
});

const timeseriesBlock = blockBase.extend({
    kind: z.literal('timeseries'),
    sql: z.string().min(1),
    chart: chartConfigSchema,
});

const tableBlock = blockBase.extend({
    kind: z.literal('table'),
    sql: z.string().min(1),
    columns: columnsSchema,
    pageSize: z.number().int().positive().optional(),
});

const markdownBlock = blockBase.extend({
    kind: z.literal('markdown'),
    body: z.string().min(1),
});

// ─── JS-derived block variants ─────────────────────────────────────────────
// A JS block computes its result in a sandboxed Web Worker from upstream
// block results + current filter values. Authors declare `inputs:` so the
// dataflow graph is explicit (and cycle-checkable); the body is JS that
// returns either `{ columns, rows }` or, for `as: metric-row`, a single
// `{ rows: [{...}] }`. The `as:` field picks the visual variant.

const jsBlockShared = blockBase.extend({
    kind: z.literal('js'),
    /** Block ids this block depends on. Result of each is exposed to `body`
     *  as `blocks[id]`. Optional — a JS block with no inputs is allowed and
     *  recomputes only when filter values change. */
    inputs: z.array(z.string().regex(BLOCK_ID_RE)).default([]),
    /** JS source. Runs in a Web Worker with `{ blocks, filters, d3 }` in
     *  scope. Must `return` a value matching the `as:` shape. */
    body: z.string().min(1),
});

const jsMetricRowBlock = jsBlockShared.extend({
    as: z.literal('metric-row'),
    metrics: metricsSchema,
});

const jsTimeseriesBlock = jsBlockShared.extend({
    as: z.literal('timeseries'),
    chart: chartConfigSchema,
});

const jsTableBlock = jsBlockShared.extend({
    as: z.literal('table'),
    columns: columnsSchema,
    pageSize: z.number().int().positive().optional(),
});

// ─── Top-level block schema ────────────────────────────────────────────────
// We can't use `discriminatedUnion('kind')` because the three JS variants
// share `kind: 'js'`. Use `z.union` and rely on Zod 4's union error
// messages — which point at the closest-matching variant when none fit.

export const blockSchema = z.union([
    metricRowBlock,
    timeseriesBlock,
    tableBlock,
    markdownBlock,
    jsMetricRowBlock,
    jsTimeseriesBlock,
    jsTableBlock,
]);
export type Block = z.infer<typeof blockSchema>;

export type SqlBlock =
    | z.infer<typeof metricRowBlock>
    | z.infer<typeof timeseriesBlock>
    | z.infer<typeof tableBlock>;

export type JsBlock =
    | z.infer<typeof jsMetricRowBlock>
    | z.infer<typeof jsTimeseriesBlock>
    | z.infer<typeof jsTableBlock>;

/** "Data block" = produces a result (excludes markdown). */
export type DataBlock = SqlBlock | JsBlock;

export function isSqlBlock(b: Block): b is SqlBlock {
    return b.kind === 'metric-row' || b.kind === 'timeseries' || b.kind === 'table';
}

export function isJsBlock(b: Block): b is JsBlock {
    return b.kind === 'js';
}

export function isDataBlock(b: Block): b is DataBlock {
    return b.kind !== 'markdown';
}

// ─── Top level ──────────────────────────────────────────────────────────────

export const dashboardSpecSchema = z.object({
    slug: z.string().regex(SLUG_RE),
    title: z.string().min(1),
    owner: z.string().min(1),
    audience: z.string().optional(),
    description: z.string().optional(),
    filters: z.array(filterSchema).default([]),
    blocks: z.array(blockSchema).min(1),
});

export type DashboardSpec = z.infer<typeof dashboardSpecSchema>;

export interface ParsedDashboard {
    spec: DashboardSpec;
    /** Body markdown after the closing `---` of the frontmatter, trimmed. */
    body: string;
}
