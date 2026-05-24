/**
 * Staged-component sketch — compact, token-budget-aware serialization
 * of the components a route's render manifest emitted to the user.
 *
 * The renderer (Slack, claude.ai MCP, CLI) consumes the FULL component
 * payload from `ctx.emitComponent`. The agent, on its next turn, needs
 * to know **what the user already sees** so it can react (decide
 * whether to add insights, deepen the view, or move on) — but it does
 * NOT need the full payload (a 1000-row table balloons the prompt
 * with data the agent already has in `result.file`).
 *
 * `sketchComponents` produces one `StagedSketch` per emitted component:
 * structural shape + a small sample, never the bulk. The sketch rides
 * back to the agent in the route result's `staged` field; the
 * accompanying `note` tells the agent the user has seen these and that
 * its `hitl.render` should add voice/insights, not re-show the data.
 *
 * Pure function. Stable schema per kind. The sketch shape is the
 * contract; the wire serialization is whatever the caller does with
 * it (typically `JSON.stringify` into the MCP tool_result).
 */

import type { ManifestComponent } from './render';

const MARKDOWN_PREVIEW_CHARS = 240;
const CODE_PREVIEW_CHARS = 200;
const STATUS_PREVIEW_CHARS = 120;
const THINKING_PREVIEW_CHARS = 200;

export type StagedSketch =
    | {
          kind: 'markdown';
          bodyPreview: string;
          bodyChars: number;
      }
    | {
          kind: 'metric';
          label: string;
          value: string | number;
          unit?: string;
      }
    | {
          kind: 'table';
          columns: string[];
          rowCount: number;
          firstRow?: Record<string, unknown>;
          caption?: string;
      }
    | {
          kind: 'code';
          language: string;
          lineCount: number;
          bodyPreview: string;
          filename?: string;
      }
    | { kind: 'link'; url: string; label?: string }
    | { kind: 'image'; url: string; alt?: string }
    | { kind: 'tree'; nodeCount: number }
    | { kind: 'attachment'; ref: string }
    | {
          kind: 'progress';
          label: string;
          current: number;
          total: number;
      }
    | { kind: 'status'; text: string; level?: string }
    | {
          kind: 'chart';
          chartType: string;
          seriesCount: number;
          seriesNames: string[];
          pointsPerSeries: number[];
          caption?: string;
      }
    | { kind: 'thinking'; text: string };

export function sketchComponents(
    components: ReadonlyArray<ManifestComponent>,
): StagedSketch[] {
    const out: StagedSketch[] = [];
    for (const c of components) {
        const s = sketchOne(c);
        if (s !== null) out.push(s);
    }
    return out;
}

function sketchOne(c: ManifestComponent): StagedSketch | null {
    // Manifest components arrive as the legacy `{kind, props}` union.
    // Cast each branch as we narrow on `kind`.
    const raw = c as { kind: string; props: Record<string, unknown> };
    const p = raw.props ?? {};
    switch (raw.kind) {
        case 'markdown': {
            const body = typeof p.body === 'string' ? p.body : '';
            return {
                kind: 'markdown',
                bodyPreview: truncate(body, MARKDOWN_PREVIEW_CHARS),
                bodyChars: body.length,
            };
        }
        case 'metric': {
            return {
                kind: 'metric',
                label: asString(p.label),
                value: asStringOrNumber(p.value),
                ...(typeof p.unit === 'string' ? { unit: p.unit } : {}),
            };
        }
        case 'table': {
            const cols = Array.isArray(p.columns) ? p.columns : [];
            const rows = Array.isArray(p.rows) ? p.rows : [];
            const columnLabels = cols.map((col) => {
                if (col && typeof col === 'object' && 'label' in col) {
                    return String((col as { label: unknown }).label);
                }
                return String(col);
            });
            const first = rows[0];
            return {
                kind: 'table',
                columns: columnLabels,
                rowCount: rows.length,
                ...(first && typeof first === 'object'
                    ? { firstRow: first as Record<string, unknown> }
                    : {}),
                ...(typeof p.caption === 'string' ? { caption: p.caption } : {}),
            };
        }
        case 'code': {
            const body = typeof p.body === 'string' ? p.body : '';
            return {
                kind: 'code',
                language: asString(p.language),
                lineCount: body ? body.split('\n').length : 0,
                bodyPreview: truncate(body, CODE_PREVIEW_CHARS),
                ...(typeof p.filename === 'string'
                    ? { filename: p.filename }
                    : {}),
            };
        }
        case 'link': {
            return {
                kind: 'link',
                url: asString(p.url),
                ...(typeof p.label === 'string' ? { label: p.label } : {}),
            };
        }
        case 'image': {
            return {
                kind: 'image',
                url: asString(p.url),
                ...(typeof p.alt === 'string' ? { alt: p.alt } : {}),
            };
        }
        case 'tree': {
            const nodes = Array.isArray(p.nodes) ? p.nodes : [];
            return { kind: 'tree', nodeCount: countTreeNodes(nodes) };
        }
        case 'attachment': {
            return { kind: 'attachment', ref: asString(p.ref) };
        }
        case 'progress': {
            return {
                kind: 'progress',
                label: asString(p.label),
                current: asNumber(p.current),
                total: asNumber(p.total),
            };
        }
        case 'status': {
            return {
                kind: 'status',
                text: truncate(asString(p.text), STATUS_PREVIEW_CHARS),
                ...(typeof p.level === 'string' ? { level: p.level } : {}),
            };
        }
        case 'chart': {
            const series = Array.isArray(p.series) ? p.series : [];
            const seriesNames: string[] = [];
            const pointsPerSeries: number[] = [];
            for (const s of series) {
                if (s && typeof s === 'object') {
                    const obj = s as { name?: unknown; data?: unknown };
                    seriesNames.push(asString(obj.name));
                    pointsPerSeries.push(
                        Array.isArray(obj.data) ? obj.data.length : 0,
                    );
                }
            }
            return {
                kind: 'chart',
                chartType: asString(p.chartType),
                seriesCount: series.length,
                seriesNames,
                pointsPerSeries,
                ...(typeof p.caption === 'string' ? { caption: p.caption } : {}),
            };
        }
        case 'thinking': {
            const text = asString(p.text);
            return {
                kind: 'thinking',
                text: truncate(text, THINKING_PREVIEW_CHARS),
            };
        }
        default:
            return null;
    }
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
}

function asString(v: unknown): string {
    return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asNumber(v: unknown): number {
    if (typeof v === 'number') return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

function asStringOrNumber(v: unknown): string | number {
    if (typeof v === 'number') return v;
    return asString(v);
}

function countTreeNodes(nodes: unknown[]): number {
    let n = 0;
    for (const node of nodes) {
        if (!node || typeof node !== 'object') continue;
        n += 1;
        const children = (node as { children?: unknown }).children;
        if (Array.isArray(children)) n += countTreeNodes(children);
    }
    return n;
}
