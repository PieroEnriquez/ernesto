/**
 * Per-Channel Catalog Factories
 *
 * Each channel gets a subset of the base catalog appropriate for its
 * rendering capabilities. The catalog's prompt() and jsonSchema() methods
 * automatically reflect only the components available for that channel.
 */

import { z } from 'zod';
import { ernestoSchema } from './schema';
import { baseCatalog, type ErnestoCatalog } from './catalog';

export type Channel = 'slack' | 'discord' | 'web' | 'admin';

/**
 * Components available per channel.
 *
 * - slack: All components (Table degrades to code block)
 * - discord: Subset — no ProductGrid, Invoice, Table, Metric
 * - web/admin: Full catalog
 */
const CHANNEL_COMPONENTS: Record<Channel, Set<string>> = {
    slack: new Set([
        'Markdown', 'Card', 'Fields', 'Actions', 'Divider',
        'ProductGrid', 'Invoice', 'Table', 'Callout', 'Metric',
    ]),
    discord: new Set([
        'Markdown', 'Card', 'Fields', 'Actions', 'Divider', 'Callout',
    ]),
    web: new Set([
        'Markdown', 'Card', 'Fields', 'Actions', 'Divider',
        'ProductGrid', 'Invoice', 'Table', 'Callout', 'Metric',
    ]),
    admin: new Set([
        'Markdown', 'Card', 'Fields', 'Actions', 'Divider',
        'ProductGrid', 'Invoice', 'Table', 'Callout', 'Metric',
    ]),
};

/**
 * Get a channel-specific catalog.
 *
 * Filters the base catalog to only include components supported by the channel.
 * The returned catalog's prompt() describes only available components,
 * and jsonSchema() validates against only those component types.
 */
export function getCatalog(channel: Channel): ErnestoCatalog {
    const allowedComponents = CHANNEL_COMPONENTS[channel];
    if (!allowedComponents) {
        return baseCatalog;
    }

    // Filter the base catalog's components to only include allowed ones
    const baseComponents = (baseCatalog.data as any).components as Record<string, { props: z.ZodType; description: string }>;
    const filtered: Record<string, { props: z.ZodType; description: string }> = {};

    for (const [name, def] of Object.entries(baseComponents)) {
        if (allowedComponents.has(name)) {
            filtered[name] = def;
        }
    }

    return ernestoSchema.createCatalog({ components: filtered }) as unknown as ErnestoCatalog;
}
