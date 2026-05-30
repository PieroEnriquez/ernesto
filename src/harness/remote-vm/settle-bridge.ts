/**
 * Settle bridge — PURE, unit-tested.
 *
 * When the in-VM agent finishes a unit of work, eden-lite ships its
 * write-overlay (changed blobs + whiteouts) to the gateway's
 * `POST /vm/settle`. This module is the harness-side helper that POSTs a
 * `VmSettleRequest` over the (token-less, brokered) backend URL and
 * returns the `SettleResult` union verbatim. Write-scope is NOT enforced
 * here — it is enforced by `makeLintWorkspace` inside the gateway's
 * `settleFromWorktree`. The harness's only job is transport + verbatim
 * pass-through.
 *
 * The `fetch` is injected so the transport is fully stubbable on macOS
 * with no live network; this file imports no cloud SDK and no native dep.
 */

import type { VmSettleRequest, VmSettleResponse } from './wire';

/** Minimal fetch surface the bridge needs (Node 18+ global `fetch`). */
export type FetchLike = (
    input: string,
    init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
    },
) => Promise<{
    status: number;
    json(): Promise<unknown>;
}>;

/** Inputs to {@link bridgeSettle}. */
export interface BridgeSettleInputs {
    /** Token-less backend base URL (the egress proxy injects the scoped
     *  bearer on the way out). */
    backendBaseUrl: string;
    /** Injected fetch implementation. */
    fetch: FetchLike;
    /** The settle request to POST. */
    request: VmSettleRequest;
}

/** Join a base URL with the settle path without doubling slashes. */
function settleUrl(baseUrl: string): string {
    const trimmed = baseUrl.replace(/\/+$/, '');
    return `${trimmed}/ernesto/vm/settle`;
}

/**
 * POST a `VmSettleRequest` to the gateway and return the `SettleResult`
 * union verbatim. Maps the gateway's HTTP status into the union when the
 * body itself is well-formed (the gateway always returns the union as
 * JSON for 200/409/422; for a pre-flight 400/403/500 it returns an
 * `{ ok:false, error }` shape we surface as a `lint_failed`-shaped
 * failure carrying the gateway error string so the agent sees it).
 *
 * Settle is NOT retried (Build Contract §2: reads are idempotent +
 * retryable, settle is issued once per agent action).
 */
export async function bridgeSettle(
    inputs: BridgeSettleInputs,
): Promise<VmSettleResponse> {
    const { backendBaseUrl, fetch, request } = inputs;
    const res = await fetch(settleUrl(backendBaseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
    });

    const body = (await res.json()) as VmSettleResponse | { ok: false; error: string };

    // 200 / 409 / 422 carry the canonical SettleResult union verbatim.
    if (
        body &&
        typeof body === 'object' &&
        'ok' in body &&
        (body.ok === true || isSettleErrorBody(body))
    ) {
        return body as VmSettleResponse;
    }

    // Pre-flight failure (400 bad_request / 403 user_revoked / 500
    // internal_error / invalid_path): surface as a lint_failed-shaped
    // result carrying the gateway's error string, so the agent gets a
    // structured, non-throwing answer (matching the never-leak-scope
    // contract — a 403/404 difference is not exposed as such).
    const gatewayError =
        body && typeof body === 'object' && 'error' in body
            ? String((body as { error: unknown }).error)
            : `vm_settle_http_${res.status}`;
    return {
        ok: false,
        error: 'lint_failed',
        errors: [{ code: 'vm_gateway_error', message: gatewayError }],
    };
}

/** True when the body is a recognized SettleResult error variant. */
function isSettleErrorBody(body: { ok: false; error?: unknown }): boolean {
    const e = body.error;
    return (
        e === 'lint_failed' ||
        e === 'fast_forward_required' ||
        e === 'merge_conflict'
    );
}
