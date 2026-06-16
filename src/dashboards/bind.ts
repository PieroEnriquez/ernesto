/**
 * Filter-state → bind-values resolution and `:bind` → `$N` substitution.
 *
 * The dashboard interpreter calls this for every block immediately before
 * dispatching `marketing://run-dashboard-block`. After this function the
 * SQL contains only positional parameters, and the values array carries
 * the typed JS scalars or arrays the backend hands straight to `pg`.
 *
 * `:bind` references are detected with the same regex the parser uses —
 * a colon that is *not* preceded by `::` (Postgres cast) or by an
 * identifier character. Casts (`col::text`) are left alone.
 */

import type { DashboardSpec, Filter } from './schema';

export type FilterValues = Record<string, FilterValue>;
export type FilterValue = DateRangeValue | string[] | string | null;

export interface DateRangeValue {
    /** ISO date (YYYY-MM-DD). */
    startDate: string;
    /** ISO date (YYYY-MM-DD). */
    endDate: string;
}

export interface BoundQuery {
    text: string;
    values: unknown[];
}

const BIND_REFERENCE_RE = /(?<![:\w]):([a-zA-Z][a-zA-Z0-9_]*)/g;

export function substituteBinds(sql: string, spec: DashboardSpec, filterValues: FilterValues): BoundQuery {
    const resolved = resolveAllBinds(spec, filterValues);
    const values: unknown[] = [];
    const placeholderByName = new Map<string, number>();

    const text = sql.replace(BIND_REFERENCE_RE, (_match, name: string) => {
        if (!Object.prototype.hasOwnProperty.call(resolved, name)) {
            throw new Error(`Unknown :bind "${name}" — no filter produces it`);
        }
        const existing = placeholderByName.get(name);
        if (existing !== undefined) return `$${existing}`;
        values.push(resolved[name]);
        const idx = values.length;
        placeholderByName.set(name, idx);
        return `$${idx}`;
    });

    return { text, values };
}

/**
 * Build the bind-name → value map by walking each filter's `binds:`
 * declaration. A `multi-select` filter with no current value becomes
 * `null` (the spec idiom `(:foo IS NULL OR col = ANY(:foo))` short-
 * circuits).
 */
function resolveAllBinds(spec: DashboardSpec, filterValues: FilterValues): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const filter of spec.filters) {
        const value = filterValues[filter.id];
        for (const [bindKey, bindRef] of Object.entries(filter.binds)) {
            const bindName = stripColon(bindRef);
            if (!bindName) continue;
            out[bindName] = valueForBind(filter, bindKey, value);
        }
    }
    return out;
}

function valueForBind(filter: Filter, bindKey: string, value: FilterValue): unknown {
    if (filter.kind === 'date-range') {
        const dr = (value as DateRangeValue | undefined) ?? defaultDateRange(filter.default);
        switch (bindKey) {
            case 'startDate':
                return dr.startDate;
            case 'endDate':
                return dr.endDate;
            case 'startDateId':
                return toDateId(dr.startDate);
            case 'endDateId':
                return toDateId(dr.endDate);
            case 'dateGrain':
                return 'month';
            default:
                return dr.startDate;
        }
    }
    if (filter.kind === 'multi-select') {
        if (!Array.isArray(value) || value.length === 0) return null;
        return value;
    }
    // single-select
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof filter.default === 'string') return filter.default;
    return null;
}

function defaultDateRange(preset: string): DateRangeValue {
    const days =
        preset === 'last_7d'
            ? 7
            : preset === 'last_30d'
              ? 30
              : preset === 'last_90d'
                ? 90
                : preset === 'last_180d'
                  ? 180
                  : preset === 'last_365d'
                    ? 365
                    : preset === 'ytd'
                      ? Math.max(1, Math.floor((Date.now() - new Date(new Date().getUTCFullYear(), 0, 1).getTime()) / 86_400_000))
                      : 90;
    const end = new Date();
    const start = new Date(end.getTime() - days * 86_400_000);
    return { startDate: iso(start), endDate: iso(end) };
}

function iso(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
}

/** YYYYMMDD integer — the Redshift sort-key convention. */
export function toDateId(iso: string): number {
    return Number.parseInt(iso.replace(/-/g, ''), 10);
}

function stripColon(bindRef: string): string | null {
    if (typeof bindRef !== 'string') return null;
    const trimmed = bindRef.trim();
    if (!trimmed.startsWith(':')) return null;
    const name = trimmed.slice(1);
    return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) ? name : null;
}
