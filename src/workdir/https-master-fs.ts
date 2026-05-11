/**
 * HTTPS master-FS adapter — Tier-C (laptop CLI / editor) reader.
 *
 * Consumes the backend's `GET /master-fs/{path}` endpoint:
 *
 *   200 → cache {etag, bytes}, return { kind: 'bytes', bytes, etag }
 *   304 → return cached bytes (must already be cached locally; else error)
 *   404 → return { kind: 'not-found' }
 *   401 / 5xx / network failure → throw (no silent fallback)
 *
 * Caches `ETag` per path in an in-process Map. On subsequent fetches we
 * send `If-None-Match: <etag>`; a 304 means we keep the cached bytes.
 *
 * Uses native `fetch` (Node 24+). No external HTTP client dependency.
 */
import { MasterFsAdapter, MasterFsResolution } from './types';

export interface HttpsMasterFsOptions {
    /** Base URL of the backend, e.g. `https://mcp.ernesto.bitrefill.com`.
     *  The adapter appends `/master-fs/<path>` per request. Trailing
     *  slashes are normalized. */
    baseUrl: string;
    /** Bearer token sent on every request as `Authorization: Bearer <token>`. */
    token: string;
    /** Optional fetch override (testing). Defaults to global `fetch`. */
    fetchImpl?: typeof fetch;
}

interface CacheEntry {
    etag: string;
    bytes: Uint8Array;
}

/** Same validation as the server's `validateRelPath`, applied client-side
 *  so we never even send obviously malicious paths over the wire. */
function isValidRelPath(raw: string): boolean {
    if (!raw) return false;
    if (raw.length > 4096) return false;
    if (raw.startsWith('/')) return false;
    if (raw.includes('\0')) return false;
    if (raw.includes('\\')) return false;
    for (const part of raw.split('/')) {
        if (part === '' || part === '.' || part === '..') return false;
    }
    return true;
}

function trimTrailingSlash(s: string): string {
    return s.endsWith('/') ? s.slice(0, -1) : s;
}

export function makeHttpsMasterFs(opts: HttpsMasterFsOptions): MasterFsAdapter {
    const baseUrl = trimTrailingSlash(opts.baseUrl);
    const token = opts.token;
    const fetchImpl: typeof fetch =
        opts.fetchImpl ?? ((...args) => (globalThis as any).fetch(...args));
    const cache = new Map<string, CacheEntry>();

    if (!baseUrl) throw new Error('makeHttpsMasterFs: baseUrl is required');
    if (!token) throw new Error('makeHttpsMasterFs: token is required');

    return {
        async resolve(masterFsPath: string): Promise<MasterFsResolution> {
            if (!isValidRelPath(masterFsPath)) {
                throw new Error(
                    `makeHttpsMasterFs: invalid master-fs path: ${JSON.stringify(masterFsPath)}`,
                );
            }

            const url = `${baseUrl}/master-fs/${masterFsPath}`;
            const headers: Record<string, string> = {
                Authorization: `Bearer ${token}`,
            };
            const cached = cache.get(masterFsPath);
            if (cached) headers['If-None-Match'] = cached.etag;

            let resp: Response;
            try {
                resp = await fetchImpl(url, { method: 'GET', headers });
            } catch (err) {
                throw new Error(
                    `makeHttpsMasterFs: network error fetching ${masterFsPath}: ${(err as Error).message}`,
                );
            }

            if (resp.status === 304) {
                if (!cached) {
                    throw new Error(
                        `makeHttpsMasterFs: server returned 304 for ${masterFsPath} but no cached entry exists`,
                    );
                }
                return { kind: 'bytes', bytes: cached.bytes, etag: cached.etag };
            }

            if (resp.status === 404) {
                return { kind: 'not-found' };
            }

            if (resp.status === 401) {
                throw new Error(
                    `makeHttpsMasterFs: unauthorized fetching ${masterFsPath} (check bearer token)`,
                );
            }

            if (resp.status !== 200) {
                throw new Error(
                    `makeHttpsMasterFs: unexpected status ${resp.status} fetching ${masterFsPath}`,
                );
            }

            const buf = await resp.arrayBuffer();
            const bytes = new Uint8Array(buf);
            const etag = resp.headers.get('etag') ?? resp.headers.get('ETag') ?? '';
            if (etag) cache.set(masterFsPath, { etag, bytes });
            return { kind: 'bytes', bytes, etag: etag || undefined };
        },
    };
}
