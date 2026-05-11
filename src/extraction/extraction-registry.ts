/**
 * Flat by-source extraction plugin registry.
 *
 * Plugins self-register at boot. Sources are unique — a duplicate registration
 * is a programming error, not a runtime fallback.
 */

import type { ExtractionPlugin } from './define-extraction';

export class ExtractionRegistry {
    private readonly bySource = new Map<string, ExtractionPlugin>();

    register(plugin: ExtractionPlugin): void {
        if (this.bySource.has(plugin.source)) {
            throw new Error(`ExtractionRegistry: duplicate source: ${plugin.source}`);
        }
        this.bySource.set(plugin.source, plugin);
    }

    get(source: string): ExtractionPlugin | undefined {
        return this.bySource.get(source);
    }

    has(source: string): boolean {
        return this.bySource.has(source);
    }

    list(): ExtractionPlugin[] {
        return Array.from(this.bySource.values());
    }
}
