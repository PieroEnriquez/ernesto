/**
 * Schema + cross-check coverage for the `kind: js` block variants and
 * the JS dataflow graph (cycles, unknown inputs, topological order).
 *
 * Pairs with `parse.test.ts` (SQL bind handling) and `bind.test.ts`
 * (positional substitution).
 */

import { describe, it, expect } from 'vitest';
import { parseDashboard, DashboardSpecError } from '../parse';
import { dataflowOrder } from '../dataflow';
import { isJsBlock, isSqlBlock, type DashboardSpec } from '../schema';

function specWith(body: string): string {
    return `---
slug: derived
title: Derived
owner: tester@bitrefill.com
filters:
  - id: dateRange
    kind: date-range
    default: last_90d
    binds:
      startDateId: :startDateId
      endDateId: :endDateId

blocks:
${body}
---
`;
}

const KPIS = `  - id: kpis
    kind: metric-row
    sql: SELECT SUM(x) AS gpv, COUNT(*) AS orders FROM t WHERE date_id BETWEEN :startDateId AND :endDateId
    metrics:
      - { col: gpv, label: GPV, format: eur }
      - { col: orders, label: Orders, format: int }`;

describe('JS block schema', () => {
    it('accepts kind:js with as:metric-row', () => {
        const raw = specWith(`${KPIS}
  - id: aov
    kind: js
    as: metric-row
    inputs: [kpis]
    body: |
      const r = blocks.kpis.rows[0];
      return { columns: ['aov'], rows: [{ aov: r.gpv / r.orders }] };
    metrics:
      - { col: aov, label: AOV, format: eur }`);

        const parsed = parseDashboard(raw);
        expect(parsed.spec.blocks).toHaveLength(2);
        const js = parsed.spec.blocks[1];
        expect(js.kind).toBe('js');
        expect(isJsBlock(js)).toBe(true);
        expect(isSqlBlock(js)).toBe(false);
        if (js.kind !== 'js') throw new Error('expected js');
        expect(js.as).toBe('metric-row');
        expect(js.inputs).toEqual(['kpis']);
    });

    it('accepts kind:js with as:timeseries (default chart config)', () => {
        const raw = specWith(`${KPIS}
  - id: trend
    kind: js
    as: timeseries
    body: |
      return { columns: ['x','y'], rows: [{x:1,y:1}] };`);
        const parsed = parseDashboard(raw);
        const js = parsed.spec.blocks[1];
        if (js.kind !== 'js' || js.as !== 'timeseries') throw new Error('shape');
        expect(js.chart.type).toBe('line');
        expect(js.inputs).toEqual([]);
    });

    it('accepts kind:js with as:table', () => {
        const raw = specWith(`${KPIS}
  - id: tbl
    kind: js
    as: table
    inputs: [kpis]
    body: |
      return { columns: ['k','v'], rows: blocks.kpis.rows };
    columns:
      - { col: k, label: K, format: text }
      - { col: v, label: V, format: int }`);
        const parsed = parseDashboard(raw);
        expect(parsed.spec.blocks[1].kind).toBe('js');
    });

    it('rejects kind:js missing as:', () => {
        const raw = specWith(`${KPIS}
  - id: bad
    kind: js
    body: return null;`);
        expect(() => parseDashboard(raw)).toThrow(DashboardSpecError);
    });

    it('rejects kind:js with unknown as: value', () => {
        const raw = specWith(`${KPIS}
  - id: bad
    kind: js
    as: line
    body: return 1;`);
        expect(() => parseDashboard(raw)).toThrow(DashboardSpecError);
    });

    it('rejects kind:js missing body', () => {
        const raw = specWith(`${KPIS}
  - id: bad
    kind: js
    as: metric-row
    metrics:
      - { col: x, label: X, format: int }`);
        expect(() => parseDashboard(raw)).toThrow(DashboardSpecError);
    });
});

describe('JS block cross-checks', () => {
    it('rejects an input referencing an unknown block', () => {
        const raw = specWith(`${KPIS}
  - id: derived
    kind: js
    as: metric-row
    inputs: [ghost]
    body: return null;
    metrics:
      - { col: a, label: A, format: int }`);
        let caught: DashboardSpecError | null = null;
        try { parseDashboard(raw); } catch (e) { caught = e as DashboardSpecError; }
        expect(caught).toBeInstanceOf(DashboardSpecError);
        expect(caught?.details?.join('\n') ?? '').toMatch(/unknown block "ghost"/);
    });

    it('rejects an input referencing a markdown block', () => {
        const raw = specWith(`  - id: note
    kind: markdown
    body: hi
  - id: derived
    kind: js
    as: metric-row
    inputs: [note]
    body: return null;
    metrics:
      - { col: a, label: A, format: int }`);
        let caught: DashboardSpecError | null = null;
        try { parseDashboard(raw); } catch (e) { caught = e as DashboardSpecError; }
        expect(caught).toBeInstanceOf(DashboardSpecError);
        expect(caught?.details?.join('\n') ?? '').toMatch(/markdown block "note"/);
    });

    it('rejects a self-referential input', () => {
        const raw = specWith(`${KPIS}
  - id: loop
    kind: js
    as: metric-row
    inputs: [loop]
    body: return null;
    metrics:
      - { col: a, label: A, format: int }`);
        let caught: DashboardSpecError | null = null;
        try { parseDashboard(raw); } catch (e) { caught = e as DashboardSpecError; }
        expect(caught).toBeInstanceOf(DashboardSpecError);
        expect(caught?.details?.join('\n') ?? '').toMatch(/lists itself/);
    });

    it('detects a two-block cycle (a → b → a)', () => {
        const raw = specWith(`${KPIS}
  - id: a
    kind: js
    as: metric-row
    inputs: [b]
    body: return null;
    metrics:
      - { col: x, label: X, format: int }
  - id: b
    kind: js
    as: metric-row
    inputs: [a]
    body: return null;
    metrics:
      - { col: x, label: X, format: int }`);
        let caught: DashboardSpecError | null = null;
        try { parseDashboard(raw); } catch (e) { caught = e as DashboardSpecError; }
        expect(caught).toBeInstanceOf(DashboardSpecError);
        expect(caught?.details?.join('\n') ?? '').toMatch(/Dataflow cycle/);
    });

    it('accepts a deep linear chain a → b → c', () => {
        const raw = specWith(`${KPIS}
  - id: a
    kind: js
    as: metric-row
    inputs: [kpis]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }
  - id: b
    kind: js
    as: metric-row
    inputs: [a]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }
  - id: c
    kind: js
    as: metric-row
    inputs: [b, a]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }`);
        expect(() => parseDashboard(raw)).not.toThrow();
    });
});

describe('dataflowOrder', () => {
    it('puts SQL leaves before JS consumers', () => {
        const raw = specWith(`${KPIS}
  - id: derived
    kind: js
    as: metric-row
    inputs: [kpis]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }`);
        const spec = parseDashboard(raw).spec;
        const order = dataflowOrder(spec);
        expect(order.indexOf('kpis')).toBeLessThan(order.indexOf('derived'));
    });

    it('orders a chain a → b → c with kpis before all', () => {
        const raw = specWith(`${KPIS}
  - id: a
    kind: js
    as: metric-row
    inputs: [kpis]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }
  - id: b
    kind: js
    as: metric-row
    inputs: [a]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }
  - id: c
    kind: js
    as: metric-row
    inputs: [b]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }`);
        const spec = parseDashboard(raw).spec;
        const order = dataflowOrder(spec);
        expect(order).toEqual(['kpis', 'a', 'b', 'c']);
    });

    it('emits each block exactly once even with diamond dependencies', () => {
        const raw = specWith(`${KPIS}
  - id: left
    kind: js
    as: metric-row
    inputs: [kpis]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }
  - id: right
    kind: js
    as: metric-row
    inputs: [kpis]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }
  - id: bottom
    kind: js
    as: metric-row
    inputs: [left, right]
    body: return { columns:['x'], rows:[{x:1}] };
    metrics:
      - { col: x, label: X, format: int }`);
        const spec: DashboardSpec = parseDashboard(raw).spec;
        const order = dataflowOrder(spec);
        expect(order).toHaveLength(4);
        expect(new Set(order).size).toBe(4);
        expect(order.indexOf('kpis')).toBeLessThan(order.indexOf('left'));
        expect(order.indexOf('left')).toBeLessThan(order.indexOf('bottom'));
        expect(order.indexOf('right')).toBeLessThan(order.indexOf('bottom'));
    });
});
