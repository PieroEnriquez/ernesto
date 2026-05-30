/**
 * Shared scope-gate primitives. Single-sources the agent-ops bypass
 * scope string and the caller-scope check used by the route and
 * extraction dispatchers, so the security-relevant bypass logic can't
 * drift between them.
 */

export const AGENT_OPS_SCOPE = 'ernesto:agent-ops';

export interface ScopeDenialDetails<S extends string = string> {
    required: ReadonlyArray<S>;
    missing: ReadonlyArray<S>;
    missingCount: number;
}

/**
 * Returns `null` when `scopes` satisfies `required` — either because
 * the caller holds the agent-ops bypass scope, or because no required
 * scope is missing. Otherwise returns the denial details.
 */
export function checkScope<S extends string>(
    required: ReadonlyArray<S>,
    scopes: ReadonlySet<S>,
): ScopeDenialDetails<S> | null {
    if ((scopes as ReadonlySet<string>).has(AGENT_OPS_SCOPE)) return null;
    const missing = required.filter((s) => !scopes.has(s));
    if (missing.length === 0) return null;
    return { required, missing, missingCount: missing.length };
}
