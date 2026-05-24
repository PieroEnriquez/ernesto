/**
 * Render manifest walker.
 *
 * A `Route` may declare an optional `render: RenderEntry[]` describing
 * how its typed output projects to {@link ManifestComponent} instances. The
 * dispatch path (or any wrapper that calls a route handler — most
 * commonly `handleExecute` in `agent-verbs/execute.ts`) walks the
 * manifest after handler success and emits one `fact.component` event
 * per matching entry.
 *
 * The manifest cuts the agent's retype loop: instead of seeing a JSON
 * blob and re-emitting `ui.markdown` / `ui.table` calls to surface the
 * data, the agent gets a stripped envelope and the user sees the
 * components rendered automatically. See
 * `workspaces/agent-ops/workflows-unification/tool-manifest.md` for the
 * full design.
 *
 * The walker is **declarative-only**: it can't transform data (sort,
 * filter, limit), only project. Transformations belong to the
 * `input.modifiers` schema, which the framework applies *before*
 * handing the output to the walker. Routes that need agent-side
 * narrative framing should omit the manifest and let the agent author
 * components manually.
 */

import type {
    UiComponent,
    RenderableComponent,
} from '../components/types';

/**
 * Transitional union — the manifest walker still builds components
 * across both top-level (thinking / status / progress / attachment)
 * and renderable (markdown / table / metric / chart / code / image /
 * link / tree) kinds. Wave 2's manifest dismantling collapses this to
 * a single shape; for now, the union lets the existing entries keep
 * building without invalidating the new top-level/renderable split.
 */
export type ManifestComponent = UiComponent | RenderableComponent;

/** `when` controls whether a render entry fires given the projected
 *  field value. Without a clause, the implicit rule is "value must be
 *  defined" (the handler said so via its output schema). */
export type WhenClause = 'present' | 'nonEmpty' | 'present:nonEmpty';

interface RenderEntryBase {
    /** JSON path into the route's output. Dot-separated. Numeric
     *  indices use bracket form (`series[0].data`). */
    path: string;
    when?: WhenClause;
}

export type RenderEntry =
    | (RenderEntryBase & { ui: 'markdown' })
    | (RenderEntryBase & {
        ui: 'metric';
        label: string;
        unit?: string;
    })
    | (RenderEntryBase & {
        ui: 'table';
        caption?: string;
        columns: {
            id: string;
            label: string;
            align?: 'left' | 'right' | 'center';
        }[];
    })
    | (RenderEntryBase & {
        ui: 'code';
        language: string;
        filename?: string;
    })
    | (RenderEntryBase & {
        ui: 'link';
        label?: string;
    })
    | (RenderEntryBase & {
        ui: 'image';
        alt?: string;
    })
    | (RenderEntryBase & { ui: 'tree' })
    | (RenderEntryBase & { ui: 'attachment' })
    | (RenderEntryBase & { ui: 'progress' })
    | (RenderEntryBase & {
        ui: 'status';
        level?: 'info' | 'progress' | 'success' | 'warn' | 'error';
    })
    | (RenderEntryBase & {
        ui: 'chart';
        chartType: 'line' | 'bar' | 'pie' | 'scatter' | 'area';
        xLabel?: string;
        yLabel?: string;
        caption?: string;
    })
    | (RenderEntryBase & { ui: 'thinking' });

/** Walk the manifest against a route's output, returning the
 *  components to render. Pure — no side effects. */
export function applyRenderManifest(
    output: unknown,
    entries: ReadonlyArray<RenderEntry>,
): ManifestComponent[] {
    const out: ManifestComponent[] = [];
    for (const entry of entries) {
        const value = getPath(output, entry.path);
        if (!whenPasses(value, entry.when)) continue;
        const component = buildManifestComponent(entry, value);
        if (component) out.push(component);
    }
    return out;
}

function getPath(obj: unknown, path: string): unknown {
    if (!obj || typeof obj !== 'object') return undefined;
    let cur: unknown = obj;
    // Accept `.` and `[N]` segments. e.g. `summary.byRegion[0].gmv`.
    const tokens = path.split(/[.[\]]+/).filter((t) => t.length > 0);
    for (const tok of tokens) {
        if (cur === undefined || cur === null) return undefined;
        if (typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[tok];
    }
    return cur;
}

function whenPasses(value: unknown, clause?: WhenClause): boolean {
    const present = value !== undefined && value !== null;
    if (!clause) return present;
    if (clause === 'present') return present;
    // Both `nonEmpty` and `present:nonEmpty` mean the same thing in
    // practice — present + non-empty for arrays/strings.
    if (!present) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
}

// Legacy-shaped component returned by the manifest. The Wave-2
// manifest dismantling rebuilds this against the new top-level /
// renderable split; until then, the cast lets the existing shape
// flow through untyped at the boundary.
type LegacyManifestComponent = { kind: string; props: Record<string, unknown> };

function buildManifestComponent(
    entry: RenderEntry,
    value: unknown,
): ManifestComponent | null {
    const built = buildLegacyComponent(entry, value);
    return built === null ? null : (built as unknown as ManifestComponent);
}

function buildLegacyComponent(
    entry: RenderEntry,
    value: unknown,
): LegacyManifestComponent | null {
    switch (entry.ui) {
        case 'markdown':
            if (typeof value !== 'string') return null;
            return { kind: 'markdown', props: { body: value } };

        case 'metric':
            if (typeof value !== 'number' && typeof value !== 'string') return null;
            return {
                kind: 'metric',
                props: {
                    label: entry.label,
                    value: value as string | number,
                    ...(entry.unit ? { unit: entry.unit } : {}),
                },
            };

        case 'table':
            if (!Array.isArray(value)) return null;
            return {
                kind: 'table',
                props: {
                    columns: entry.columns,
                    rows: value as Record<string, unknown>[],
                    ...(entry.caption ? { caption: entry.caption } : {}),
                },
            };

        case 'code':
            if (typeof value !== 'string') return null;
            return {
                kind: 'code',
                props: {
                    language: entry.language,
                    body: value,
                    ...(entry.filename ? { filename: entry.filename } : {}),
                },
            };

        case 'link': {
            if (typeof value === 'string')
                return {
                    kind: 'link',
                    props: { url: value, label: entry.label ?? value },
                };
            if (value && typeof value === 'object' && 'url' in value) {
                const v = value as { url: string; label?: string; icon?: string };
                return {
                    kind: 'link',
                    props: {
                        url: v.url,
                        label: v.label ?? entry.label ?? v.url,
                        ...(v.icon ? { icon: v.icon } : {}),
                    },
                };
            }
            return null;
        }

        case 'image': {
            if (typeof value === 'string')
                return {
                    kind: 'image',
                    props: { url: value, ...(entry.alt ? { alt: entry.alt } : {}) },
                };
            if (value && typeof value === 'object' && 'url' in value) {
                return { kind: 'image', props: value as { url: string; alt?: string } };
            }
            return null;
        }

        case 'tree':
            if (!Array.isArray(value)) return null;
            return {
                kind: 'tree',
                props: { nodes: value as import('../components/types').TreeNode[] },
            };

        case 'attachment':
            if (value && typeof value === 'object' && 'ref' in value)
                return { kind: 'attachment', props: value as { ref: string } };
            return null;

        case 'progress':
            if (value && typeof value === 'object')
                return {
                    kind: 'progress',
                    props: value as {
                        label: string;
                        current: number;
                        total: number;
                        eta?: string;
                    },
                };
            return null;

        case 'status': {
            if (typeof value === 'string')
                return {
                    kind: 'status',
                    props: { text: value, ...(entry.level ? { level: entry.level } : {}) },
                };
            if (value && typeof value === 'object' && 'text' in value)
                return {
                    kind: 'status',
                    props: value as {
                        text: string;
                        level?: 'info' | 'progress' | 'success' | 'warn' | 'error';
                    },
                };
            return null;
        }

        case 'chart': {
            if (!value || typeof value !== 'object') return null;
            const series = Array.isArray(value)
                ? value
                : (value as { series?: unknown }).series;
            if (!Array.isArray(series)) return null;
            return {
                kind: 'chart',
                props: {
                    series: series as { name: string; data: { x: unknown; y: number }[] }[],
                    chartType: entry.chartType,
                    ...(entry.xLabel ? { xLabel: entry.xLabel } : {}),
                    ...(entry.yLabel ? { yLabel: entry.yLabel } : {}),
                    ...(entry.caption ? { caption: entry.caption } : {}),
                },
            };
        }

        case 'thinking':
            if (typeof value === 'string')
                return { kind: 'thinking', props: { text: value } };
            return null;
    }
}
