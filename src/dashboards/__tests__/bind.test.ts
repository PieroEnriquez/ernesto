/**
 * Bind substitution — turning a spec block's `:bindName` SQL plus the
 * current filter state into a parameterized `{ text, values }` payload
 * for `pg.Pool.query`.
 *
 * The substitution must:
 *   - Dedupe repeated `:bindName` references to the same `$N`.
 *   - Leave Postgres `::cast` syntax alone.
 *   - Coerce date-range filters to ISO strings and YYYYMMDD ints.
 *   - Send `null` for empty multi-select arrays so the spec idiom
 *     `(:foo IS NULL OR col = ANY(:foo))` short-circuits.
 */

import { describe, it, expect } from 'vitest';
import { substituteBinds, toDateId } from '../bind';
import { dashboardSpecSchema } from '../schema';

function makeSpec() {
    return dashboardSpecSchema.parse({
        slug: 'payments',
        title: 'Payments',
        owner: 'a',
        filters: [
            {
                id: 'dateRange',
                kind: 'date-range',
                default: 'last_90d',
                binds: {
                    startDateId: ':startDateId',
                    endDateId: ':endDateId',
                },
            },
            {
                id: 'methods',
                kind: 'multi-select',
                options: ['visa', 'mc'],
                binds: { methods: ':methods' },
            },
        ],
        blocks: [
            {
                id: 'b',
                kind: 'metric-row',
                sql: 'SELECT 1 AS gpv',
                metrics: [{ col: 'gpv', label: 'GPV', format: 'eur' }],
            },
        ],
    });
}

describe('substituteBinds', () => {
    it('substitutes :bind references into $N placeholders', () => {
        const spec = makeSpec();
        const filterValues = {
            dateRange: { startDate: '2026-02-20', endDate: '2026-05-20' },
            methods: ['visa', 'mc'],
        };
        const result = substituteBinds(
            'SELECT SUM(x) FROM t WHERE date_id BETWEEN :startDateId AND :endDateId AND m = ANY(:methods)',
            spec,
            filterValues,
        );
        expect(result.text).toBe('SELECT SUM(x) FROM t WHERE date_id BETWEEN $1 AND $2 AND m = ANY($3)');
        expect(result.values).toEqual([20260220, 20260520, ['visa', 'mc']]);
    });

    it('dedupes repeated :bind references to the same placeholder', () => {
        const spec = makeSpec();
        const filterValues = {
            dateRange: { startDate: '2026-02-20', endDate: '2026-05-20' },
            methods: [],
        };
        const result = substituteBinds('SELECT 1 WHERE (:methods IS NULL OR m = ANY(:methods))', spec, filterValues);
        expect(result.text).toBe('SELECT 1 WHERE ($1 IS NULL OR m = ANY($1))');
        expect(result.values).toEqual([null]);
    });

    it('leaves Postgres ::cast syntax alone', () => {
        const spec = makeSpec();
        const filterValues = {
            dateRange: { startDate: '2026-02-20', endDate: '2026-05-20' },
            methods: [],
        };
        const result = substituteBinds(
            'SELECT (date_id::TEXT)::DATE AS d FROM t WHERE date_id BETWEEN :startDateId AND :endDateId',
            spec,
            filterValues,
        );
        expect(result.text).toContain('::TEXT');
        expect(result.text).toContain('::DATE');
        expect(result.text).toContain('BETWEEN $1 AND $2');
    });

    it('throws on a :bind that has no producing filter', () => {
        const spec = makeSpec();
        expect(() => substituteBinds('SELECT :ghost', spec, { dateRange: null, methods: [] })).toThrow(/Unknown :bind/);
    });
});

describe('toDateId', () => {
    it('strips dashes from an ISO date string', () => {
        expect(toDateId('2026-02-20')).toBe(20260220);
    });
});
