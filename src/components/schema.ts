/**
 * Ernesto UI Schema
 *
 * Defines the json-render schema for Ernesto's generative UI.
 * Uses a flat element tree (root, elements, state) optimized for LLM generation.
 *
 * The schema tells json-render HOW specs and catalogs are structured.
 * The catalog (catalog.ts) tells it WHAT components are available.
 */

import { defineSchema } from '@json-render/core';

export const ernestoSchema = defineSchema(
    (s) => ({
        spec: s.object({
            root: s.string(),
            elements: s.record(
                s.object({
                    type: s.ref('catalog.components'),
                    props: s.propsOf('catalog.components'),
                    children: s.array(s.string()),
                }),
            ),
            state: { ...s.record(s.any()), ...s.optional() },
        }),
        catalog: s.object({
            components: s.map({
                props: s.zod(),
                description: s.string(),
            }),
        }),
    }),
    {
        defaultRules: [
            'Output a flat element tree with root, elements, and optional state.',
            'Each element has type (component name), props (component-specific), and children (element keys).',
            'Use summary field for session summary. UI goes in root/elements/state.',
        ],
    },
);
