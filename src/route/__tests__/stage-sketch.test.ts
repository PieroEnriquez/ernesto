import { describe, expect, it } from 'vitest';
import { sketchComponents, type StagedSketch } from '../stage-sketch';
import type { ManifestComponent } from '../render';

// Cast helper — the manifest walker hands us a structurally-shaped
// union; tests construct equivalent literals and cast at the boundary.
const m = (k: string, props: Record<string, unknown>): ManifestComponent =>
    ({ kind: k, props }) as unknown as ManifestComponent;

describe('sketchComponents', () => {
    it('summarizes a markdown body by length + preview, never the full body', () => {
        const long = 'A'.repeat(1000);
        const [s] = sketchComponents([m('markdown', { body: long })]);
        expect(s).toBeDefined();
        const md = s as Extract<StagedSketch, { kind: 'markdown' }>;
        expect(md.kind).toBe('markdown');
        expect(md.bodyChars).toBe(1000);
        // Preview hits the truncation cap, ends with the ellipsis marker.
        expect(md.bodyPreview.length).toBeLessThan(300);
        expect(md.bodyPreview.endsWith('…')).toBe(true);
    });

    it('keeps short markdown bodies verbatim', () => {
        const [s] = sketchComponents([m('markdown', { body: 'Hi.' })]);
        const md = s as Extract<StagedSketch, { kind: 'markdown' }>;
        expect(md.bodyPreview).toBe('Hi.');
        expect(md.bodyChars).toBe(3);
    });

    it('sketches a table as columns + rowCount + firstRow, never the full rows', () => {
        const rows = Array.from({ length: 500 }, (_, i) => ({
            region: `R${i}`,
            gmv: i * 100,
        }));
        const [s] = sketchComponents([
            m('table', {
                columns: [
                    { id: 'region', label: 'Region' },
                    { id: 'gmv', label: 'GMV' },
                ],
                rows,
                caption: 'Revenue by region',
            }),
        ]);
        const t = s as Extract<StagedSketch, { kind: 'table' }>;
        expect(t.kind).toBe('table');
        expect(t.columns).toEqual(['Region', 'GMV']);
        expect(t.rowCount).toBe(500);
        expect(t.firstRow).toEqual({ region: 'R0', gmv: 0 });
        expect(t.caption).toBe('Revenue by region');
        // Crucial: the 500-row array MUST NOT round-trip into the sketch.
        const json = JSON.stringify(s);
        expect(json.length).toBeLessThan(500);
    });

    it('handles a metric with optional unit', () => {
        const [withUnit, withoutUnit] = sketchComponents([
            m('metric', { label: 'GMV', value: 722800, unit: 'EUR' }),
            m('metric', { label: 'Orders', value: 12 }),
        ]);
        expect(withUnit).toEqual({
            kind: 'metric',
            label: 'GMV',
            value: 722800,
            unit: 'EUR',
        });
        expect(withoutUnit).toEqual({
            kind: 'metric',
            label: 'Orders',
            value: 12,
        });
    });

    it('summarizes a chart by series names + points per series, never the points', () => {
        const data = Array.from({ length: 200 }, (_, i) => ({ x: i, y: i * 2 }));
        const [s] = sketchComponents([
            m('chart', {
                chartType: 'line',
                series: [
                    { name: 'us', data },
                    { name: 'uk', data: data.slice(0, 50) },
                ],
                caption: 'Revenue trend',
            }),
        ]);
        const c = s as Extract<StagedSketch, { kind: 'chart' }>;
        expect(c.chartType).toBe('line');
        expect(c.seriesCount).toBe(2);
        expect(c.seriesNames).toEqual(['us', 'uk']);
        expect(c.pointsPerSeries).toEqual([200, 50]);
        // Crucial: no raw `data` arrays leak into the sketch.
        const json = JSON.stringify(s);
        expect(json).not.toContain('"y":');
    });

    it('counts code lines + truncates body', () => {
        const body = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
        const [s] = sketchComponents([
            m('code', { language: 'ts', body, filename: 'foo.ts' }),
        ]);
        const c = s as Extract<StagedSketch, { kind: 'code' }>;
        expect(c.language).toBe('ts');
        expect(c.lineCount).toBe(80);
        expect(c.filename).toBe('foo.ts');
        expect(c.bodyPreview.length).toBeLessThan(220);
        expect(c.bodyPreview.endsWith('…')).toBe(true);
    });

    it('counts tree nodes recursively', () => {
        const [s] = sketchComponents([
            m('tree', {
                nodes: [
                    {
                        label: 'a',
                        children: [
                            { label: 'a.1' },
                            { label: 'a.2', children: [{ label: 'a.2.1' }] },
                        ],
                    },
                    { label: 'b' },
                ],
            }),
        ]);
        const t = s as Extract<StagedSketch, { kind: 'tree' }>;
        // 2 top + 2 a-children + 1 a.2-child = 5
        expect(t.nodeCount).toBe(5);
    });

    it('passes through link / image / progress / status / attachment shapes', () => {
        const sketches = sketchComponents([
            m('link', { url: 'https://x.test', label: 'X' }),
            m('image', { url: 'https://i.test/a.png', alt: 'a' }),
            m('progress', { label: 'load', current: 3, total: 10 }),
            m('status', { text: 'querying…', level: 'progress' }),
            m('attachment', { ref: 'wrk:abc' }),
        ]);
        expect(sketches).toEqual([
            { kind: 'link', url: 'https://x.test', label: 'X' },
            { kind: 'image', url: 'https://i.test/a.png', alt: 'a' },
            { kind: 'progress', label: 'load', current: 3, total: 10 },
            { kind: 'status', text: 'querying…', level: 'progress' },
            { kind: 'attachment', ref: 'wrk:abc' },
        ]);
    });

    it('drops components with unknown kinds rather than crashing', () => {
        const out = sketchComponents([
            m('markdown', { body: 'ok' }),
            m('not-a-real-kind', { whatever: true }),
        ]);
        expect(out).toHaveLength(1);
        expect((out[0] as { kind: string }).kind).toBe('markdown');
    });

    it('returns an empty array when given no components', () => {
        expect(sketchComponents([])).toEqual([]);
    });
});
