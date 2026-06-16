/**
 * Flat by-URI route registry.
 *
 * Routes self-register at boot. URIs are unique — a duplicate registration is
 * a programming error, not a runtime fallback.
 */

import type { Route } from './define-route';
import { KeyedRegistry } from '../shared/keyed-registry';

/**
 * Per-route custom compactor — overrides the generic `compactify`
 * walker for the `preview` field in the agent's tool_result. A route
 * may register one when its data shape benefits from domain-specific
 * shrinkage (e.g. project a wide row onto just the columns the
 * subsequent reasoning typically needs). The fallback when this is
 * unset / returns undefined is the generic compactify.
 */
export type RouteCompactor = (data: unknown, limit: number) => unknown;

export class RouteRegistry extends KeyedRegistry<Route> {
    private readonly compactors = new Map<string, RouteCompactor>();

    constructor() {
        super((route) => route.uri, 'RouteRegistry', 'URI');
    }

    /** Register a per-route compactor. Caller responsible for routes
     *  matching the URI; duplicate registration overwrites. */
    registerCompactor(uri: string, fn: RouteCompactor): void {
        this.compactors.set(uri, fn);
    }

    /** Look up a custom compactor; the dispatch layer calls this and
     *  falls back to the generic `compactify` when undefined. */
    getCompactor(uri: string): RouteCompactor | undefined {
        return this.compactors.get(uri);
    }
}
