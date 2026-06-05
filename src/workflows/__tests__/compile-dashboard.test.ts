/**
 * Compile a `DashboardSpec` → `WorkflowDeclaration`.
 *
 * Synthesizes a small in-memory spec instead of going through
 * `parseDashboard` so the test surface is the compiler itself.
 */

import { describe, it, expect } from 'vitest';
import { dashboardSpecSchema, type DashboardSpec } from '../../dashboards/schema';
import { compileDashboardSpecToWorkflow } from '../compile-dashboard';

function buildSpec(overrides: Partial<DashboardSpec> = {}): DashboardSpec {
    const base = {
        slug: 'payments-revenue',
        title: 'Payments Revenue',
        owner: 'april@example.com',
        description: 'Daily revenue + top users.',
        filters: [
            {
                id: 'dateRange',
                kind: 'date-range' as const,
                default: 'last_90d' as const,
                binds: { startDateId: ':startDateId', endDateId: ':endDateId' },
            },
            {
                id: 'product',
                kind: 'single-select' as const,
                options: ['amazon', 'mercado_libre'],
                default: 'amazon',
                binds: { product: ':product' },
            },
        ],
        blocks: [
            {
                id: 'revenue',
                kind: 'timeseries' as const,
                sql: 'select date, sum(amount) from orders where product = :product group by date',
                chart: { type: 'line' as const, stacked: false, yFormat: 'float' as const },
            },
            {
                id: 'top_users',
                kind: 'table' as const,
                sql: 'select user_id, sum(amount) from orders where amount > {{ revenue }} group by user_id',
                columns: [
                    { col: 'user_id', label: 'User', format: 'text' as const },
                    { col: 'amount', label: 'Amount', format: 'eur' as const },
                ],
            },
            {
                id: 'notes',
                kind: 'markdown' as const,
                body: 'Notes go here.',
            },
        ],
        ...overrides,
    };
    return dashboardSpecSchema.parse(base);
}

describe('compileDashboardSpecToWorkflow', () => {
    it('compiles a basic dashboard with filters → inputs and blocks → route steps', () => {
        const wf = compileDashboardSpecToWorkflow(buildSpec());
        expect(wf.name).toBe('payments-revenue');
        expect(wf.tags).toEqual(['dashboard']);
        expect(wf.owner).toBe('april@example.com');
        expect(Object.keys(wf.inputs ?? {})).toEqual(['dateRange', 'product']);
        expect(wf.inputs?.dateRange.type).toBe('date_range');
        expect(wf.inputs?.product.type).toBe('string');
        expect(wf.inputs?.product.enum).toEqual(['amazon', 'mercado_libre']);

        expect(Object.keys(wf.steps)).toEqual(['notes', 'revenue', 'top_users']);

        const revenue = wf.steps.revenue;
        if (revenue.kind === 'route') {
            expect(revenue.uri).toBe('redshift://query');
            expect(revenue.render).toBe('chart');
        }
        const notes = wf.steps.notes;
        if (notes.kind === 'route') {
            expect(notes.uri).toBe('_ernesto://markdown');
            expect(notes.render).toBe('markdown');
        }
    });

    it('chains steps in stable lexicographic dataflow order', () => {
        const wf = compileDashboardSpecToWorkflow(buildSpec());
        const order = Object.keys(wf.steps);
        // notes (no deps) + revenue (no deps) + top_users (depends on
        // revenue through `{{ revenue }}` but the spec doesn't declare
        // it via inputs — so all three are "ready". Lexicographic
        // tie-break: notes < revenue < top_users.
        expect(order).toEqual(['notes', 'revenue', 'top_users']);
        // The chain wires up next:
        const ns = wf.steps.notes;
        const rv = wf.steps.revenue;
        const tu = wf.steps.top_users;
        if (ns.kind === 'route') expect(ns.next).toBe('revenue');
        if (rv.kind === 'route') expect(rv.next).toBe('top_users');
        if (tu.kind === 'route') expect(tu.next).toBe('outputs.blocks');
    });

    it('rewrites {{ <blockId> }} cross-block refs into ${{ steps.<id>.output }}', () => {
        const wf = compileDashboardSpecToWorkflow(buildSpec());
        const top = wf.steps.top_users;
        if (top.kind === 'route') {
            const template = (top.params?.template ?? '') as string;
            expect(template).toContain('${{ steps.revenue.output }}');
            expect(template).not.toContain('{{ revenue }}');
        }
    });

    it('preserves render annotations per block kind', () => {
        const wf = compileDashboardSpecToWorkflow(buildSpec());
        if (wf.steps.revenue.kind === 'route') expect(wf.steps.revenue.render).toBe('chart');
        if (wf.steps.top_users.kind === 'route') expect(wf.steps.top_users.render).toBe('table');
        if (wf.steps.notes.kind === 'route') expect(wf.steps.notes.render).toBe('markdown');
    });

    it('produces byte-identical output across two compiles (determinism)', () => {
        const a = compileDashboardSpecToWorkflow(buildSpec());
        const b = compileDashboardSpecToWorkflow(buildSpec());
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('outputs.blocks.from lists every block in dataflow order with shape:dashboard', () => {
        const wf = compileDashboardSpecToWorkflow(buildSpec());
        expect(wf.outputs?.blocks.from).toEqual(['notes', 'revenue', 'top_users']);
        expect(wf.outputs?.blocks.shape).toBe('dashboard');
    });

    it('handles JS blocks: emits _ernesto://js_exec route with inputs', () => {
        const spec = dashboardSpecSchema.parse({
            slug: 'js-only',
            title: 'JS',
            owner: 'x@example.com',
            filters: [],
            blocks: [
                {
                    id: 'src',
                    kind: 'metric-row' as const,
                    sql: 'select 1 as x',
                    metrics: [{ col: 'x', label: 'X', format: 'int' as const }],
                },
                {
                    id: 'derived',
                    kind: 'js' as const,
                    as: 'metric-row' as const,
                    inputs: ['src'],
                    body: 'return { rows: [{ x: blocks.src.rows[0].x * 2 }] };',
                    metrics: [{ col: 'x', label: 'X×2', format: 'int' as const }],
                },
            ],
        });
        const wf = compileDashboardSpecToWorkflow(spec);
        const derived = wf.steps.derived;
        if (derived.kind === 'route') {
            expect(derived.uri).toBe('_ernesto://js_exec');
            expect((derived.params as Record<string, unknown>).inputs).toEqual(['src']);
            expect(derived.render).toBe('value');
        }
    });
});
