/**
 * Flat by-source extraction plugin registry.
 *
 * Plugins self-register at boot. Sources are unique — a duplicate registration
 * is a programming error, not a runtime fallback.
 */

import type { ExtractionPlugin } from './define-extraction';
import { KeyedRegistry } from '../shared/keyed-registry';

export class ExtractionRegistry extends KeyedRegistry<ExtractionPlugin> {
    constructor() {
        super((plugin) => plugin.source, 'ExtractionRegistry', 'source');
    }
}
