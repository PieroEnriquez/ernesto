/**
 * Shared HTTP scaffold for the extraction plugins.
 *
 * The clickup / crowdin / devin / github / qase plugins each re-implemented a
 * byte-identical-ish GET-with-retry routine: an AbortController timeout, 429
 * exponential backoff, 404 → sentinel, 401/403 → throw, other non-2xx → throw.
 * That core lives here as `fetchWithRetry`, parameterized over the bits that
 * genuinely differ per plugin (error-message prefix, auth-rejected hint,
 * request headers).
 *
 * NOT covered here (and deliberately left bespoke in their plugins):
 *   - `drive`: 401 → token-refresh-and-retry loop, body-text error shaping, and
 *     a `FetchOutcome` return type — observably different from the 5 plugins.
 *   - `slack`: HTTP 200 + `{ ok: false }` body semantics and `Retry-After`
 *     header handling — a different success/error model entirely.
 * Those two still share `sleep` and the default constants from this module.
 *
 * This module is internal to the plugins layer. It is intentionally NOT
 * exported from any barrel — only the plugin factories are public API.
 */

import type { ExtractionContext } from '../define-extraction';

/** Default per-request timeout (ms) shared by every HTTP plugin. */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** Default number of retries (after the first attempt) on a 429. */
export const DEFAULT_MAX_RETRIES = 3;
/** Default base for the exponential 429 backoff: `base * 2^attempt`. */
export const DEFAULT_BACKOFF_BASE_MS = 500;

/** Promise-based sleep used by every plugin's backoff path. */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pretty-printed JSON, two-space indent — the shared entry-content format. */
export function stringifyJson(payload: unknown): string {
    return JSON.stringify(payload, null, 2);
}

export interface ClampPageSizeOptions {
    /** Upper bound (inclusive). */
    max: number;
    /** Value returned when `n` is not usable. */
    fallback: number;
    /**
     * When true (qase semantics), a non-positive `n` falls back to `fallback`.
     * When false (devin/crowdin semantics), `n` is merely floored up to 1.
     * Defaults to false.
     */
    rejectNonPositive?: boolean;
}

/**
 * Clamp a caller-supplied page size into `[1, max]`. Mirrors the three
 * per-plugin clamps exactly via the options:
 *   - qase:    { max: 100, fallback: 100, rejectNonPositive: true }
 *   - devin:   { max: 100, fallback: 100 }
 *   - crowdin: { max: 500, fallback: 500 }
 */
export function clampPageSize(n: number, opts: ClampPageSizeOptions): number {
    if (opts.rejectNonPositive) {
        if (!Number.isFinite(n) || n <= 0) return opts.fallback;
        return Math.min(Math.max(1, Math.floor(n)), opts.max);
    }
    if (!Number.isFinite(n)) return opts.fallback;
    return Math.min(Math.max(Math.floor(n), 1), opts.max);
}

export interface FetchWithRetryOptions {
    /** Per-request timeout in ms. */
    timeoutMs: number;
    /** Max retries after the first attempt, applied only to 429s. */
    maxRetries: number;
    /** Base for the `base * 2^attempt` backoff delay. */
    backoffBaseMs: number;
    log: ExtractionContext['log'];
    /**
     * Error-message prefix and the source label used in log/throw messages,
     * e.g. `github`. Appears as `${source}: ...`.
     */
    source: string;
    /** A short label for the resource being fetched, e.g. `pr`, `commits`. */
    kind: string;
    /** Request headers (auth + accept). Each plugin builds these itself. */
    headers: Record<string, string>;
    /**
     * Hint appended to the auth-rejected (401/403) error after
     * `— check `, e.g. `token and scopes` or `apiKey and org access`.
     */
    authHint: string;
    /** Human-readable label for the rate-limit log line, e.g. `GitHub`. */
    rateLimitLabel: string;
}

/**
 * GET `url` with the shared retry/error machinery:
 *   - AbortController timeout (`timeoutMs`),
 *   - network error → throw `${source}: network error fetching ${kind}: …`,
 *   - 404 → `'not_found'` sentinel,
 *   - 429 (while attempts remain) → exponential backoff + retry,
 *   - 401/403 → throw `${source}: auth rejected (status N) for ${kind} — check ${authHint}`,
 *   - other non-2xx → throw `${source}: ${kind} fetch failed with status N`,
 *   - 2xx → resolve with the raw `Response` (callers decode as needed).
 */
export async function fetchWithRetry(
    url: string,
    opts: FetchWithRetryOptions,
): Promise<Response | 'not_found'> {
    let attempt = 0;
    // attempts: 1 initial + maxRetries retries (only on 429).
    while (true) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
        let res: Response;
        try {
            res = await fetch(url, {
                method: 'GET',
                headers: opts.headers,
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`${opts.source}: network error fetching ${opts.kind}: ${message}`);
        }
        clearTimeout(timer);

        if (res.status === 404) {
            return 'not_found';
        }

        if (res.status === 429 && attempt < opts.maxRetries) {
            const delay = opts.backoffBaseMs * Math.pow(2, attempt);
            opts.log.warn(`${opts.rateLimitLabel} rate limited, backing off`, {
                kind: opts.kind,
                attempt: attempt + 1,
                delayMs: delay,
            });
            attempt += 1;
            await sleep(delay);
            continue;
        }

        if (res.status === 401 || res.status === 403) {
            throw new Error(
                `${opts.source}: auth rejected (status ${res.status}) for ${opts.kind} — check ${opts.authHint}`,
            );
        }

        if (!res.ok) {
            throw new Error(`${opts.source}: ${opts.kind} fetch failed with status ${res.status}`);
        }

        return res;
    }
}
