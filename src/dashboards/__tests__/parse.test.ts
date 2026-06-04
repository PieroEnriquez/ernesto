/**
 * Spec parser + cross-checks. These tests guard the contract every
 * `.dashboard.md` author depends on: a clear "what's wrong" message
 * when something doesn't validate.
 */

import { describe, it, expect } from 'vitest';
import { parseDashboard, DashboardSpecError } from '../parse';

const MINIMAL_SPEC = `---
slug: payments
title: Payments
owner: april@example.com
filters:
  - id: dateRange
    kind: date-range
    default: last_90d
    binds:
      startDateId: :startDateId
      endDateId: :endDateId

blocks:
  - id: kpis
    kind: metric-row
    sql: SELECT SUM(x) AS gpv FROM t WHERE date_id BETWEEN :startDateId AND :endDateId
    metrics:
      - { col: gpv, label: GPV, format: eur }
---

# Notes
The body.
`;

describe('parseDashboard', () => {
    it('parses a minimal valid spec', () => {
        const parsed = parseDashboard(MINIMAL_SPEC);
        expect(parsed.spec.slug).toBe('payments');
        expect(parsed.spec.title).toBe('Payments');
        expect(parsed.spec.blocks).toHaveLength(1);
        expect(parsed.body).toContain('The body.');
    });

    it('throws on missing frontmatter', () => {
        expect(() => parseDashboard('# No frontmatter')).toThrow(DashboardSpecError);
    });

    it('throws on invalid YAML in frontmatter', () => {
        const raw = '---\nslug: [unclosed\n---\n';
        expect(() => parseDashboard(raw)).toThrow(DashboardSpecError);
    });

    it('throws on bad slug regex', () => {
        const raw = MINIMAL_SPEC.replace('slug: payments', 'slug: 1bad');
        expect(() => parseDashboard(raw)).toThrow(DashboardSpecError);
    });

    it('throws when a block references an undeclared :bind', () => {
        const raw = MINIMAL_SPEC.replace(
            'AND :endDateId',
            'AND :nonexistent',
        );
        let caught: DashboardSpecError | null = null;
        try {
            parseDashboard(raw);
        } catch (e) {
            caught = e as DashboardSpecError;
        }
        expect(caught).toBeInstanceOf(DashboardSpecError);
        expect(caught?.details?.join('\n') ?? '').toMatch(/unknown :bind "nonexistent"/);
    });

    it('throws on duplicate block ids', () => {
        const raw = MINIMAL_SPEC.replace(
            /blocks:[\s\S]*?---/,
            `blocks:
  - id: kpis
    kind: metric-row
    sql: SELECT SUM(x) AS gpv FROM t WHERE date_id BETWEEN :startDateId AND :endDateId
    metrics:
      - { col: gpv, label: GPV, format: eur }
  - id: kpis
    kind: markdown
    body: hi
---`,
        );
        let caught: DashboardSpecError | null = null;
        try {
            parseDashboard(raw);
        } catch (e) {
            caught = e as DashboardSpecError;
        }
        expect(caught).toBeInstanceOf(DashboardSpecError);
        expect(caught?.details?.join('\n') ?? '').toMatch(/Duplicate block id: kpis/);
    });

    it('treats Postgres `::cast` syntax as not a bind reference', () => {
        const raw = MINIMAL_SPEC.replace(
            'SELECT SUM(x) AS gpv FROM t WHERE date_id BETWEEN :startDateId AND :endDateId',
            "SELECT (date_id::TEXT)::DATE AS d FROM t WHERE date_id BETWEEN :startDateId AND :endDateId",
        ).replace(
            'metrics:\n      - { col: gpv, label: GPV, format: eur }',
            'metrics:\n      - { col: d, label: Date, format: text }',
        );
        // Should not throw on `::TEXT` or `::DATE` — those are casts, not binds.
        const parsed = parseDashboard(raw);
        expect(parsed.spec.blocks[0].kind).toBe('metric-row');
    });

    it('accepts reserved binds without explicit filter declaration', () => {
        const raw = `---
slug: minimal
title: Minimal
owner: nobody
blocks:
  - id: m
    kind: markdown
    body: hi
---
`;
        const parsed = parseDashboard(raw);
        expect(parsed.spec.slug).toBe('minimal');
    });
});
