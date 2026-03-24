/**
 * Ernesto Component System
 *
 * json-render based component catalog for generative UI.
 * Agents describe UI intent via structured JSON specs.
 * Each channel has its own renderer and component subset.
 */

export { ernestoSchema } from './schema';
export { baseCatalog, type ErnestoCatalog } from './catalog';
export { getCatalog, type Channel } from './channels';
export type { Spec as UISpec, UIElement } from '@json-render/core';
