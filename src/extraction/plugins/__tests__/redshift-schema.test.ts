import { describe, it, expect, vi } from 'vitest';
import { redshiftSchemaPlugin } from '../redshift-schema';
import type { ExtractionContext } from '../../define-extraction';

const makeCtx = (): ExtractionContext => ({
    user: { id: 'u1' },
    scopes: new Set(['extraction:redshift_schema:read']),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

/**
 * Builds a query function that returns canned rows based on which SQL string
 * arrives. Both arguments are matched as substrings so the test doesn't have
 * to mirror the default SQL byte-for-byte.
 */
function fakeQuery(tables: unknown[], columns: unknown[]) {
    return vi.fn(async (sql: string) => {
        if (sql.includes('util_dbt_table_descriptions')) return { rows: tables };
        if (sql.includes('util_dbt_column_descriptions')) return { rows: columns };
        throw new Error(`unexpected SQL: ${sql}`);
    });
}

describe('redshiftSchemaPlugin', () => {
    it('exposes source / scope', () => {
        const plugin = redshiftSchemaPlugin({ query: async () => ({ rows: [] }) });
        expect(plugin.source).toBe('redshift_schema');
        expect(plugin.scope).toEqual(['extraction:redshift_schema:read']);
    });

    it('rejects construction without a query function', () => {
        expect(() =>
            // @ts-expect-error — exercising the runtime guard
            redshiftSchemaPlugin({}),
        ).toThrow(/query/);
    });

    it('emits one entry per table for the `tables` target, with denormalised columns', async () => {
        const query = fakeQuery(
            [
                { table_schema: 'public', table_name: 'agg_orders', approx_rows: '1,234,567', size_mb: '42.5', description: 'agg' },
                { table_schema: 'public', table_name: 'fact_users', approx_rows: 10, size_mb: 5, description: '' },
            ],
            [
                { table_schema: 'public', table_name: 'agg_orders', column_name: 'order_id', datatype: 'varchar', description: 'pk' },
                { table_schema: 'public', table_name: 'agg_orders', column_name: 'total', data_type: 'numeric', description: '' },
                { table_schema: 'public', table_name: 'fact_users', column_name: 'user_id', datatype: 'int', description: '' },
            ],
        );

        const plugin = redshiftSchemaPlugin({ query });
        const result = await plugin.fetch({ target: 'tables' }, makeCtx());

        expect(result.entries.map((e) => e.path).sort()).toEqual(['tables/public.agg_orders.json', 'tables/public.fact_users.json']);

        const agg = JSON.parse(result.entries.find((e) => e.path.includes('agg_orders'))!.content);
        expect(agg.column_count).toBe(2);
        expect(agg.approx_rows).toBe(1234567); // commas stripped
        expect(agg.columns[0]).toMatchObject({ column_name: 'order_id', datatype: 'varchar', description: 'pk' });
        // data_type alias is preserved as datatype
        expect(agg.columns[1].datatype).toBe('numeric');

        // SQL queries run exactly once each.
        expect(query).toHaveBeenCalledTimes(2);
    });

    it('filters tables by regex on `tables:<regex>`', async () => {
        const query = fakeQuery(
            [
                { table_schema: 'public', table_name: 'agg_orders' },
                { table_schema: 'public', table_name: 'fact_users' },
                { table_schema: 'public', table_name: 'stg_raw_events' },
                { table_schema: 'public', table_name: 'dim_currency' },
            ],
            [],
        );

        const plugin = redshiftSchemaPlugin({ query });
        const result = await plugin.fetch({ target: 'tables:^(agg|fact)_' }, makeCtx());

        const names = result.entries.map((e) => e.path).sort();
        expect(names).toEqual(['tables/public.agg_orders.json', 'tables/public.fact_users.json']);
    });

    it('returns one entry for `table:<schema>.<name>`, or zero when missing', async () => {
        const query = fakeQuery(
            [{ table_schema: 'analytics', table_name: 'sessions' }],
            [{ table_schema: 'analytics', table_name: 'sessions', column_name: 'sid', datatype: 'uuid' }],
        );

        const plugin = redshiftSchemaPlugin({ query });

        const hit = await plugin.fetch({ target: 'table:analytics.sessions' }, makeCtx());
        expect(hit.entries).toHaveLength(1);
        expect(hit.entries[0].path).toBe('tables/analytics.sessions.json');

        const miss = await plugin.fetch({ target: 'table:analytics.does_not_exist' }, makeCtx());
        expect(miss.entries).toEqual([]);
    });

    it('rejects malformed targets', async () => {
        const plugin = redshiftSchemaPlugin({ query: async () => ({ rows: [] }) });
        await expect(plugin.fetch({ target: 'bogus' }, makeCtx())).rejects.toThrow();
        await expect(plugin.fetch({ target: 'tables:' }, makeCtx())).rejects.toThrow(/empty/);
        await expect(plugin.fetch({ target: 'tables:[unterminated' }, makeCtx())).rejects.toThrow(/invalid regex/);
        await expect(plugin.fetch({ target: 'table:no_dot' }, makeCtx())).rejects.toThrow(/schema.*name/);
    });

    it('wraps a failing query function as a fetch error', async () => {
        const plugin = redshiftSchemaPlugin({
            query: async () => {
                throw new Error('connection refused');
            },
        });
        await expect(plugin.fetch({ target: 'tables' }, makeCtx())).rejects.toThrow(/metadata query failed/);
    });
});
