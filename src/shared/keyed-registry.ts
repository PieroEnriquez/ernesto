/**
 * Generic flat by-key registry.
 *
 * Entries self-register at boot. Keys are unique — a duplicate
 * registration is a programming error, not a runtime fallback. The
 * route and extraction registries are both thin wrappers over this,
 * keyed on `uri` and `source` respectively.
 *
 * `label` is interpolated into the duplicate-key error message so each
 * wrapper keeps its existing, asserted error text (e.g.
 * `RouteRegistry: duplicate URI: …`).
 */
export class KeyedRegistry<T> {
    private readonly byKey = new Map<string, T>();

    constructor(
        private readonly keyOf: (entry: T) => string,
        private readonly label: string,
        private readonly keyName: string,
    ) {}

    register(entry: T): void {
        const key = this.keyOf(entry);
        if (this.byKey.has(key)) {
            throw new Error(`${this.label}: duplicate ${this.keyName}: ${key}`);
        }
        this.byKey.set(key, entry);
    }

    get(key: string): T | undefined {
        return this.byKey.get(key);
    }

    has(key: string): boolean {
        return this.byKey.has(key);
    }

    list(): T[] {
        return Array.from(this.byKey.values());
    }
}
