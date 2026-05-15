/**
 * Redshift schema extraction plugin.
 *
 * Indexes table+column metadata from a Redshift cluster as a JSON document per
 * table, so the redshift workspace can answer "what columns does X have?" /
 * "which tables exist?" via the ask() route. The runtime analyst route
 * (redshift://analyst) queries the warehouse directly and is unaffected.
 *
 * Unlike the other plugins this is **not** an HTTP-backed source. Redshift is
 * reached via the consumer's existing connection pool — the plugin accepts a
 * `query` function and emits SQL that targets two metadata tables (the dbt
 * descriptions views). Authentication, retries, and connection lifecycle are
 * the consumer's responsibility.
 *
 * Default queries:
 *   - tables:  `SELECT * FROM public.util_dbt_table_descriptions`
 *   - columns: `SELECT * FROM public.util_dbt_column_descriptions`
 *
 * Both are overridable via plugin options for clusters that materialise the
 * descriptions elsewhere.
 *
 * Target syntax:
 *   - `tables`                       — every table in the warehouse.
 *   - `tables:<regex>`               — tables whose `table_name` matches the
 *                                       regex (JavaScript syntax, no flags;
 *                                       e.g. `^agg_`, `^(agg|fact)_`,
 *                                       `_summary$`). Anchor as needed.
 *   - `table:<schema>.<name>`        — a single table.
 *
 * Output entries:
 *   - `tables/<schema>.<name>.json` — pretty-printed object containing
 *     `{ table_schema, table_name, description, columns: [{ column_name,
 *     datatype, description }], column_count, approx_rows, size_mb, diststyle,
 *     sortkey_first_col, sortkey_num }`. contentType `application/json`.
 *
 * Failure shape contract:
 *   - Missing tables (404-equivalent) → empty entries.
 *   - Query failures → throw; dispatcher wraps as `fetch_failed`.
 *   - Invalid regex → throw at fetch time, surfaced as `fetch_failed`.
 */

import {
    defineExtraction,
    type ExtractionContext,
    type ExtractionEntry,
    type ExtractionPlugin,
    type ExtractionRequest,
    type ExtractionResult,
} from '../define-extraction';

export type RedshiftQueryFn = (sql: string) => Promise<{ rows: unknown[] }>;

export interface RedshiftSchemaPluginOptions {
    /**
     * Runs a SQL string and returns `{ rows: [...] }`. Both schema-discovery
     * queries are read-only `SELECT`s against the dbt metadata views by
     * default.
     */
    query: RedshiftQueryFn;
    /** Overridable; defaults to `SELECT * FROM public.util_dbt_table_descriptions`. */
    tablesQuery?: string;
    /** Overridable; defaults to `SELECT * FROM public.util_dbt_column_descriptions`. */
    columnsQuery?: string;
}

const DEFAULT_TABLES_QUERY = 'SELECT * FROM public.util_dbt_table_descriptions';
const DEFAULT_COLUMNS_QUERY = 'SELECT * FROM public.util_dbt_column_descriptions';

interface TableRow {
    table_schema: string;
    table_name: string;
    description?: string | null;
    approx_rows?: number | string | null;
    size_mb?: number | string | null;
    diststyle?: string | null;
    sortkey_first_col?: string | null;
    sortkey_num?: number | string | null;
}

interface ColumnRow {
    table_schema: string;
    table_name: string;
    column_name?: string | null;
    datatype?: string | null;
    data_type?: string | null;
    description?: string | null;
}

interface DenormalisedTable {
    table_schema: string;
    table_name: string;
    description: string;
    columns: { column_name: string; datatype: string; description: string }[];
    column_count: number;
    approx_rows: number;
    size_mb: number;
    diststyle: string | null;
    sortkey_first_col: string | null;
    sortkey_num: number;
}

type ParsedTarget =
    | { kind: 'tables-all' }
    | { kind: 'tables-regex'; pattern: RegExp }
    | { kind: 'table'; schema: string; tableName: string };

export function redshiftSchemaPlugin(opts: RedshiftSchemaPluginOptions): ExtractionPlugin {
    if (!opts || typeof opts.query !== 'function') {
        throw new Error('redshiftSchemaPlugin: query function is required');
    }
    const tablesQuery = opts.tablesQuery ?? DEFAULT_TABLES_QUERY;
    const columnsQuery = opts.columnsQuery ?? DEFAULT_COLUMNS_QUERY;
    const query = opts.query;

    return defineExtraction({
        source: 'redshift_schema',
        scope: 'extraction:redshift_schema:read',
        description:
            'Index Redshift table+column metadata. Targets: tables, tables:{regex}, table:{schema}.{name}.',
        fetch: async (req: ExtractionRequest, ctx: ExtractionContext): Promise<ExtractionResult> => {
            const parsed = parseTarget(req.target);
            const fetchedAt = new Date().toISOString();

            // The dbt-descriptions views are small (one row per table / column)
            // and the metadata schema rarely shifts during a single extraction
            // run, so we pay the round-trip once and filter in memory.
            const tables = await loadDenormalisedTables(query, tablesQuery, columnsQuery, ctx);

            let selected: DenormalisedTable[];
            if (parsed.kind === 'tables-all') {
                selected = tables;
            } else if (parsed.kind === 'tables-regex') {
                selected = tables.filter((t) => parsed.pattern.test(t.table_name));
            } else {
                const match = tables.find(
                    (t) => t.table_schema === parsed.schema && t.table_name === parsed.tableName,
                );
                selected = match ? [match] : [];
            }

            const entries: ExtractionEntry[] = selected.map((t) => ({
                path: `tables/${t.table_schema}.${t.table_name}.json`,
                content: JSON.stringify(t, null, 2),
                contentType: 'application/json',
            }));

            return { entries, fetchedAt };
        },
    });
}

function parseTarget(target: string): ParsedTarget {
    if (target === 'tables') return { kind: 'tables-all' };

    const idx = target.indexOf(':');
    if (idx < 0) {
        throw new Error(
            'redshift_schema: target must be "tables", "tables:{regex}", or "table:{schema}.{name}"',
        );
    }
    const kind = target.slice(0, idx);
    const rest = target.slice(idx + 1);

    if (kind === 'tables') {
        // `tables:<regex>` — the rest is the pattern. Be deliberate about
        // regex source: trim whitespace but otherwise preserve the literal so
        // anchors / character classes / alternation all work.
        const patternSrc = rest.trim();
        if (!patternSrc) {
            throw new Error('redshift_schema: tables target regex is empty');
        }
        let pattern: RegExp;
        try {
            pattern = new RegExp(patternSrc);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`redshift_schema: invalid regex "${patternSrc}" — ${message}`);
        }
        return { kind: 'tables-regex', pattern };
    }
    if (kind === 'table') {
        const dotIdx = rest.indexOf('.');
        if (dotIdx <= 0 || dotIdx === rest.length - 1) {
            throw new Error('redshift_schema: table target must be "table:{schema}.{name}"');
        }
        return {
            kind: 'table',
            schema: rest.slice(0, dotIdx).trim(),
            tableName: rest.slice(dotIdx + 1).trim(),
        };
    }
    throw new Error(`redshift_schema: unsupported target kind: ${kind}`);
}

async function loadDenormalisedTables(
    query: RedshiftQueryFn,
    tablesQuery: string,
    columnsQuery: string,
    ctx: ExtractionContext,
): Promise<DenormalisedTable[]> {
    let tablesResult: { rows: unknown[] };
    let columnsResult: { rows: unknown[] };
    try {
        [tablesResult, columnsResult] = await Promise.all([
            query(tablesQuery),
            query(columnsQuery),
        ]);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.log.error('redshift_schema: metadata query failed', { message });
        throw new Error(`redshift_schema: metadata query failed: ${message}`);
    }

    const columnsByKey = new Map<string, { column_name: string; datatype: string; description: string }[]>();
    for (const raw of columnsResult.rows) {
        const c = raw as ColumnRow;
        if (!c.table_schema || !c.table_name) continue;
        const key = `${c.table_schema}.${c.table_name}`;
        const bucket = columnsByKey.get(key) ?? [];
        bucket.push({
            column_name: c.column_name ?? 'unknown',
            datatype: c.datatype ?? c.data_type ?? 'unknown',
            description: c.description ?? '',
        });
        columnsByKey.set(key, bucket);
    }

    const result: DenormalisedTable[] = [];
    for (const raw of tablesResult.rows) {
        const t = raw as TableRow;
        if (!t.table_schema || !t.table_name) continue;
        const key = `${t.table_schema}.${t.table_name}`;
        const columns = columnsByKey.get(key) ?? [];
        result.push({
            table_schema: t.table_schema,
            table_name: t.table_name,
            description: t.description ?? '',
            columns,
            column_count: columns.length,
            approx_rows: parseNumeric(t.approx_rows),
            size_mb: parseNumeric(t.size_mb),
            diststyle: t.diststyle ?? null,
            sortkey_first_col: t.sortkey_first_col ?? null,
            sortkey_num: parseNumeric(t.sortkey_num),
        });
    }
    return result;
}

function parseNumeric(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (value === null || value === undefined) return 0;
    // Redshift can return numerics as strings with thousand separators
    // (e.g. "1,234,567") depending on driver; strip them before parsing.
    const cleaned = String(value).replace(/,/g, '');
    const parsed = parseFloat(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
}
