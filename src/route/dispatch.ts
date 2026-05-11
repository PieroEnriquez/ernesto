/**
 * Route dispatch.
 *
 * One body for all three tier-frontends (Tier A in-process, Tier B MCP, Tier C
 * HTTPS). Looks up by URI, gates on scope, Zod-validates input + output, runs
 * the handler, and shapes errors into a discriminated `DispatchResult`.
 *
 * Spec deviation: the full signature in §30 is
 * `dispatchRoute(workdir, uri, params) → RouteResult`, where the Workdir
 * carries the registry, principal, and scope. This scaffolding takes
 * `(registry, uri, params, ctx)` directly — Workdir does not yet expose a
 * `registry` field, and `Principal` does not yet exist on the lib. The
 * Workdir-bound signature lands when B.6 wires the backend; this module's
 * shape is the substrate.
 */

import type { RouteRegistry } from './route-registry';
import type { Route, RouteContext, RouteScope } from './define-route';

const AGENT_OPS_SCOPE: RouteScope = 'ernesto:agent-ops';

export type DispatchErrorCode =
    | 'route_not_found'
    | 'scope_denied'
    | 'invalid_input'
    | 'invalid_output'
    | 'handler_failed';

export type DispatchResult =
    | { ok: true; data: unknown }
    | { ok: false; error: DispatchErrorCode; details?: unknown };

export async function dispatchRoute(
    registry: RouteRegistry,
    uri: string,
    params: unknown,
    ctx: RouteContext,
): Promise<DispatchResult> {
    const route = registry.get(uri);
    if (!route) {
        return { ok: false, error: 'route_not_found', details: { uri } };
    }

    const scopeDenial = checkScope(route, ctx.scopes);
    if (scopeDenial) {
        return { ok: false, error: 'scope_denied', details: scopeDenial };
    }

    const parsedInput = route.input.safeParse(params);
    if (!parsedInput.success) {
        return {
            ok: false,
            error: 'invalid_input',
            details: { issues: parsedInput.error.issues },
        };
    }

    let raw: unknown;
    try {
        raw = await route.handler(parsedInput.data, ctx);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'handler_failed', details: { message } };
    }

    const parsedOutput = route.output.safeParse(raw);
    if (!parsedOutput.success) {
        ctx.log.error('Route returned output that failed schema validation', {
            uri: route.uri,
            issues: parsedOutput.error.issues,
        });
        return {
            ok: false,
            error: 'invalid_output',
            details: { issues: parsedOutput.error.issues },
        };
    }

    return { ok: true, data: parsedOutput.data };
}

interface ScopeDenialDetails {
    required: ReadonlyArray<RouteScope>;
    missing: ReadonlyArray<RouteScope>;
    missingCount: number;
}

function checkScope(route: Route, scopes: ReadonlySet<RouteScope>): ScopeDenialDetails | null {
    if (scopes.has(AGENT_OPS_SCOPE)) return null;
    const missing = route.scope.filter((s) => !scopes.has(s));
    if (missing.length === 0) return null;
    return {
        required: route.scope,
        missing,
        missingCount: missing.length,
    };
}
