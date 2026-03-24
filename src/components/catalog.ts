/**
 * Ernesto Component Catalog
 *
 * Base catalog of all UI components available to Ernesto agents.
 * Each component has Zod props (for validation + JSON Schema generation)
 * and a description (auto-injected into agent prompt via catalog.prompt()).
 *
 * Component types map 1:1 to the existing AgentUIOutput block types,
 * plus new components (Table, Callout, Metric) for richer output.
 */

import { z } from 'zod';
import { ernestoSchema } from './schema';

// ── Component Prop Schemas ───────────────────────────────────────────────────

const markdownProps = z.object({
    content: z.string().describe('Markdown text content'),
});

const cardProps = z.object({
    title: z.string().describe('Card title'),
    subtitle: z.string().optional().describe('Card subtitle text'),
    image_url: z.string().optional().describe('Card header image URL'),
});

const fieldsProps = z.object({
    items: z.array(z.object({
        label: z.string(),
        value: z.string(),
    })).describe('Key-value pairs rendered in a compact grid'),
});

const actionDef = z.object({
    id: z.string().describe('Action ID for handler routing'),
    label: z.string().describe('Button label text'),
    style: z.enum(['primary', 'danger', 'default']).optional(),
    value: z.string().optional().describe('Opaque context string for the handler'),
    url: z.string().optional().describe('If set, renders as link button'),
});

const actionsProps = z.object({
    actions: z.array(actionDef).describe('Interactive buttons'),
});

const dividerProps = z.object({});

const productGridProps = z.object({
    product_id: z.string().describe('Bitrefill product slug'),
    currency: z.string().describe('Display currency (USD, EUR, BTC, etc.)'),
    show_packages: z.boolean().describe('Whether to show package selection buttons'),
});

const invoiceProps = z.object({
    invoice_id: z.string().describe('Bitrefill invoice ID'),
    poll: z.boolean().describe('Whether to start polling for status updates'),
});

const tableProps = z.object({
    columns: z.array(z.object({
        key: z.string(),
        label: z.string(),
    })).describe('Column definitions'),
    data: z.array(z.record(z.string(), z.unknown())).describe('Row data objects'),
});

const calloutProps = z.object({
    variant: z.enum(['info', 'warn', 'error']).describe('Visual style'),
    content: z.string().describe('Callout message text'),
});

const metricProps = z.object({
    label: z.string().describe('Metric name'),
    value: z.string().describe('Metric value (formatted)'),
    change: z.string().optional().describe('Change amount (e.g., "+3.2%")'),
    trend: z.enum(['up', 'down', 'flat']).optional().describe('Trend direction'),
});

// ── Base Catalog ─────────────────────────────────────────────────────────────

export const baseCatalog = ernestoSchema.createCatalog({
    components: {
        Markdown: {
            props: markdownProps,
            description: 'Markdown text block. Use for any prose, explanations, or formatted text.',
        },
        Card: {
            props: cardProps,
            description: 'Container with title, optional subtitle and image. Accepts children (Fields, Actions, Markdown).',
        },
        Fields: {
            props: fieldsProps,
            description: 'Key-value pairs in a compact grid. Use for structured data display.',
        },
        Actions: {
            props: actionsProps,
            description: 'Row of interactive buttons. Use url for link buttons, id for action buttons.',
        },
        Divider: {
            props: dividerProps,
            description: 'Visual separator between sections.',
        },
        ProductGrid: {
            props: productGridProps,
            description: 'Bitrefill product card with optional package selection. Renders natively on each platform.',
        },
        Invoice: {
            props: invoiceProps,
            description: 'Invoice status card with optional polling. Renders purchase status natively.',
        },
        Table: {
            props: tableProps,
            description: 'Data table with column headers and rows. Degrades to code block on Slack.',
        },
        Callout: {
            props: calloutProps,
            description: 'Highlighted message box. Use info for tips, warn for warnings, error for errors.',
        },
        Metric: {
            props: metricProps,
            description: 'Single KPI display with label, value, and optional trend indicator.',
        },
    },
});

export type ErnestoCatalog = typeof baseCatalog;
