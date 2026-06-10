/**
 * Egress-policy builder — PURE, unit-tested.
 *
 * The remote-vm layer's security model is a deny-all TLS-SNI firewall with
 * an allowlist of EXACTLY two destinations: the backend API host (which
 * serves the scope-gated `/vm/*` gateway) and the Anthropic model
 * endpoint. Full Bash + WebFetch are safe inside the VM because there is
 * no third destination to exfiltrate to, and SNI-level matching means a
 * DNS-rebind cannot escape (the cert's SNI, not a resolved IP, is the
 * gate).
 *
 * This module derives that allowlist from a backend base URL and a model
 * base URL. It is the single source of truth for "what can the VM reach".
 */

import type { NetworkPolicy } from './sandbox-client';

/** Anthropic's default API host — used when the model base URL is the
 *  public endpoint and no explicit host is configured. */
const DEFAULT_ANTHROPIC_HOST = 'api.anthropic.com';

/**
 * Extract the bare hostname from a URL or host string. Accepts
 * `https://host/path`, `host:443`, or `host`. Throws on input that has
 * no recoverable host — fail-closed, since a malformed host would
 * otherwise widen the allowlist.
 */
export function hostOf(urlOrHost: string): string {
    const trimmed = urlOrHost.trim();
    if (trimmed.length === 0) {
        throw new Error('egress: empty host');
    }
    // Has a scheme → parse as URL.
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
        const u = new URL(trimmed);
        if (!u.hostname) throw new Error('egress: URL has no hostname');
        return u.hostname;
    }
    // Bare `host` or `host:port` — strip any port and path.
    const hostPart = trimmed.split('/')[0]!.split(':')[0]!;
    if (hostPart.length === 0) {
        throw new Error('egress: unparseable host');
    }
    return hostPart;
}

/** Inputs to {@link buildEgressPolicy}. */
export interface EgressInputs {
    /** Backend base URL the in-VM eden-lite + agent talk to
     *  (serves `/vm/*`). */
    backendBaseUrl: string;
    /** Anthropic model base URL. Optional — defaults to the public
     *  Anthropic API host. */
    modelBaseUrl?: string;
    /** Extra CIDR allowlist (rarely needed; threaded through verbatim). */
    allowCidrs?: string[];
}

/**
 * Build the deny-all + 2-host allowlist `NetworkPolicy`.
 *
 * Invariants (asserted by tests):
 *   - exactly the backend host + the model host appear in `allowDomains`;
 *   - duplicates are collapsed (backend == model host → one entry);
 *   - hosts are bare hostnames (no scheme, no port, no path);
 *   - order is deterministic: backend first, then model.
 */
export function buildEgressPolicy(inputs: EgressInputs): NetworkPolicy {
    const backendHost = hostOf(inputs.backendBaseUrl);
    const modelHost = inputs.modelBaseUrl ? hostOf(inputs.modelBaseUrl) : DEFAULT_ANTHROPIC_HOST;

    const allowDomains: string[] = [backendHost];
    if (modelHost !== backendHost) {
        allowDomains.push(modelHost);
    }

    const policy: NetworkPolicy = { allowDomains };
    if (inputs.allowCidrs && inputs.allowCidrs.length > 0) {
        policy.allowCidrs = [...inputs.allowCidrs];
    }
    return policy;
}
