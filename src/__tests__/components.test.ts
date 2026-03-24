import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ernestoSchema, baseCatalog, getCatalog } from '../components';

describe('Component Catalog', () => {
    describe('baseCatalog', () => {
        it('has all 10 components', () => {
            expect(baseCatalog.componentNames).toHaveLength(10);
            expect(baseCatalog.componentNames).toEqual([
                'Markdown', 'Card', 'Fields', 'Actions', 'Divider',
                'ProductGrid', 'Invoice', 'Table', 'Callout', 'Metric',
            ]);
        });

        it('generates a prompt with all component names', () => {
            const prompt = baseCatalog.prompt({ mode: 'generate' });
            expect(prompt).toContain('Markdown');
            expect(prompt).toContain('Card');
            expect(prompt).toContain('Table');
            expect(prompt).toContain('Callout');
            expect(prompt).toContain('Metric');
            expect(prompt).toContain('ProductGrid');
            expect(prompt).toContain('Invoice');
        });

        it('prompt includes component descriptions', () => {
            const prompt = baseCatalog.prompt({ mode: 'generate' });
            expect(prompt).toContain('Markdown text block');
            expect(prompt).toContain('Container with title');
            expect(prompt).toContain('Data table');
        });

        it('validates a valid spec', () => {
            const spec = {
                root: 'main',
                elements: {
                    main: {
                        type: 'Markdown',
                        props: { content: 'Hello world' },
                        children: [],
                    },
                },
                state: {},
            };
            const result = baseCatalog.validate(spec);
            expect(result.success).toBe(true);
        });

        it('validates a spec with nested elements', () => {
            const spec = {
                root: 'card1',
                elements: {
                    card1: {
                        type: 'Card',
                        props: { title: 'Test Card' },
                        children: ['fields1', 'actions1'],
                    },
                    fields1: {
                        type: 'Fields',
                        props: { items: [{ label: 'Status', value: 'Active' }] },
                        children: [],
                    },
                    actions1: {
                        type: 'Actions',
                        props: { actions: [{ id: 'btn1', label: 'Click' }] },
                        children: [],
                    },
                },
            };
            const result = baseCatalog.validate(spec);
            expect(result.success).toBe(true);
        });

        it('rejects invalid component types', () => {
            const spec = {
                root: 'main',
                elements: {
                    main: {
                        type: 'NonExistentComponent',
                        props: { content: 'Hello' },
                        children: [],
                    },
                },
                state: {},
            };
            const result = baseCatalog.validate(spec);
            expect(result.success).toBe(false);
        });
    });

    describe('getCatalog', () => {
        it('returns full catalog for slack', () => {
            const catalog = getCatalog('slack');
            expect(catalog.componentNames).toHaveLength(10);
        });

        it('returns subset for discord', () => {
            const catalog = getCatalog('discord');
            expect(catalog.componentNames).toHaveLength(6);
            expect(catalog.componentNames).toContain('Markdown');
            expect(catalog.componentNames).toContain('Card');
            expect(catalog.componentNames).toContain('Callout');
            expect(catalog.componentNames).not.toContain('ProductGrid');
            expect(catalog.componentNames).not.toContain('Invoice');
            expect(catalog.componentNames).not.toContain('Table');
        });

        it('returns full catalog for web', () => {
            const catalog = getCatalog('web');
            expect(catalog.componentNames).toHaveLength(10);
        });

        it('returns full catalog for admin', () => {
            const catalog = getCatalog('admin');
            expect(catalog.componentNames).toHaveLength(10);
        });

        it('generates channel-specific prompt for discord', () => {
            const catalog = getCatalog('discord');
            const prompt = catalog.prompt({ mode: 'generate' });
            expect(prompt).toContain('Markdown');
            expect(prompt).toContain('Card');
            expect(prompt).not.toContain('ProductGrid');
        });

        it('validates discord-only component types', () => {
            const discordCatalog = getCatalog('discord');
            const result = discordCatalog.validate({
                root: 'main',
                elements: {
                    main: {
                        type: 'Callout',
                        props: { variant: 'info', content: 'Note' },
                        children: [],
                    },
                },
                state: {},
            });
            expect(result.success).toBe(true);
        });

        it('rejects components not in discord catalog', () => {
            const discordCatalog = getCatalog('discord');
            const result = discordCatalog.validate({
                root: 'main',
                elements: {
                    main: {
                        type: 'ProductGrid',
                        props: { product_id: 'test', currency: 'USD', show_packages: true },
                        children: [],
                    },
                },
                state: {},
            });
            expect(result.success).toBe(false);
        });
    });

    describe('ernestoSchema', () => {
        it('can create a custom catalog', () => {
            const custom = ernestoSchema.createCatalog({
                components: {
                    MyWidget: {
                        props: z.object({ label: z.string() }),
                        description: 'Custom widget',
                    },
                },
            });
            expect(custom.componentNames).toEqual(['MyWidget']);
            expect(custom.prompt()).toContain('MyWidget');
        });
    });
});
