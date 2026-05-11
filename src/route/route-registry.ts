/**
 * Flat by-URI route registry.
 *
 * Routes self-register at boot. URIs are unique — a duplicate registration is
 * a programming error, not a runtime fallback.
 */

import type { Route } from './define-route';

export class RouteRegistry {
    private readonly byUri = new Map<string, Route>();

    register(route: Route): void {
        if (this.byUri.has(route.uri)) {
            throw new Error(`RouteRegistry: duplicate URI: ${route.uri}`);
        }
        this.byUri.set(route.uri, route);
    }

    get(uri: string): Route | undefined {
        return this.byUri.get(uri);
    }

    has(uri: string): boolean {
        return this.byUri.has(uri);
    }

    list(): Route[] {
        return Array.from(this.byUri.values());
    }
}
