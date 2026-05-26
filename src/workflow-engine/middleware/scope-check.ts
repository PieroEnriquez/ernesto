/**
 * `scopeCheckMiddleware` — the §7.4 scope-narrowing chokepoint, lifted
 * out of the subworkflow handler into uniform middleware that runs on
 * every dispatch.
 *
 * Contract:
 *
 *   principal.scopes ⊇ kind.scope
 *
 * For workflow kinds, `kind.scope` comes from
 * `decl.declaration.scope`. For route kinds, it comes from
 * `decl.route.scope` (which can be static or a per-input function).
 *
 * For service principals: the check is bypassed UNLESS the kind
 * declares a service-allowlist policy. Service principals are
 * non-interactive and authorized by virtue of which worker is calling
 * (validated at the queue / scheduler layer, not here).
 *
 * Throws `ScopeEscalationError` on missing scopes — the runner
 * catches and surfaces as `{ status: 'errored', error: {...} }`.
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';
import { isServicePrincipal } from '../principal';
import type { KindDecl } from '../kind-registry';

/** Error thrown by the middleware when scope check fails. */
export class ScopeEscalationError extends Error {
    readonly code = 'scope_escalation';
    readonly missing: ReadonlyArray<string>;
    constructor(kindUri: string, missing: ReadonlyArray<string>) {
        super(
            `kind "${kindUri}" declared scopes the caller lacks: ${missing.join(',')}`,
        );
        this.name = 'ScopeEscalationError';
        this.missing = missing;
    }
}

/** Build the middleware. Static factory so callers can pass an
 *  optional service-allowlist that bypasses the check for trusted
 *  workers. The allowlist is keyed by `workerId`. */
export function scopeCheckMiddleware(opts: {
    /** Service workers whose scope check is bypassed. Defaults to
     *  "all service principals bypass" because today the queue +
     *  scheduler layer is the trusted boundary. */
    serviceAllowlist?: 'all' | ReadonlySet<string>;
} = {}): DispatchMiddleware {
    const allowlist = opts.serviceAllowlist ?? 'all';

    return {
        name: 'scope-check',
        before(ctx: DispatchPreContext): DispatchPreContext {
            const { principal, decl } = ctx;
            if (!decl) {
                // No decl resolved yet — the runner sets `decl` before
                // invoking middleware. If it's absent, something earlier
                // in the chain went wrong; nothing for this middleware
                // to do.
                return ctx;
            }

            // Service principal bypass.
            if (isServicePrincipal(principal)) {
                if (allowlist === 'all') return ctx;
                if (allowlist.has(principal.workerId)) return ctx;
                // Service principal NOT on allowlist — fall through to
                // the strict check (which it will fail because it has
                // no scope set).
            }

            const declared = collectDeclaredScopes(decl, ctx.inputs);
            if (declared.length === 0) return ctx;

            // User principal: enforce caller.scopes ⊇ declared.
            const callerScopes = isServicePrincipal(principal)
                ? new Set<string>()
                : principal.scopes;

            const missing: string[] = [];
            for (const s of declared) {
                if (!callerScopes.has(s)) missing.push(s);
            }
            if (missing.length > 0) {
                throw new ScopeEscalationError(decl.uri, missing);
            }

            return ctx;
        },
    };
}

/** Collect the kind's declared scopes. For route kinds, the scope can
 *  be a function of the input (dynamic-scope routes, commit
 *  `afea0c1`); resolve by calling it. */
function collectDeclaredScopes(
    decl: KindDecl,
    inputs: Record<string, unknown>,
): string[] {
    if (decl.kind === 'route') {
        const s = decl.route.scope;
        if (Array.isArray(s)) return [...s];
        if (typeof s === 'function') {
            const resolved = s(inputs);
            return [...(resolved as Iterable<string>)];
        }
        return [];
    }
    return decl.declaration.scope ?? [];
}
