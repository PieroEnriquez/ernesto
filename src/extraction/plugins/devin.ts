/**
 * Devin extraction plugin.
 *
 * Fetches playbooks (reusable instruction templates) from Devin's REST API at
 * `https://api.devin.ai/v3/organizations/{orgId}/playbooks`. Sessions, knowledge
 * notes, and other Devin entities are intentionally out of scope here — this
 * plugin only indexes the playbook catalogue for discovery via the devin
 * workspace's ask() route. Runtime Devin calls (creating sessions, polling
 * status) live in the backend, not in this plugin.
 *
 * Auth model:
 *   - `Authorization: Bearer <apiKey>` on every request.
 *
 * Target syntax:
 *   - `playbooks`        — every playbook in the organisation, paginated via
 *                          `first=100&after=<cursor>` and walked to completion.
 *                          One entry per playbook.
 *   - `playbook:<id>`    — a single playbook by id. One entry, or zero on 404.
 *
 * Output entries:
 *   - `playbooks/<id>.json` — pretty-printed raw playbook JSON, contentType
 *     `application/json`.
 *
 * Failure shape contract:
 *   - 404 → empty entries (target absent is not a fatal error).
 *   - 429 → exponential backoff, up to 3 retries.
 *   - other non-2xx → throw; dispatcher wraps as `fetch_failed`.
 *
 * The API key is never logged.
 */

import {
    defineExtraction,
    type ExtractionContext,
    type ExtractionEntry,
    type ExtractionPlugin,
    type ExtractionRequest,
    type ExtractionResult,
} from '../define-extraction';
import {
    clampPageSize as httpClampPageSize,
    DEFAULT_BACKOFF_BASE_MS,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT_MS,
    fetchWithRetry as httpFetchWithRetry,
} from './_http';

export interface DevinPluginOptions {
    apiKey: string;
    orgId: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    backoffBaseMs?: number;
    /** Page size for the playbook listing (1..100). */
    pageSize?: number;
}

const DEFAULT_BASE_URL = 'https://api.devin.ai/v3';
const DEFAULT_PAGE_SIZE = 100;

interface DevinPlaybook {
    playbook_id: string;
    title?: string | null;
    updated_at?: string | null;
    created_at?: string | null;
    [key: string]: unknown;
}

interface DevinPaginatedResponse<T> {
    items: T[];
    has_next_page?: boolean;
    end_cursor?: string | null;
}

export function devinPlugin(opts: DevinPluginOptions): ExtractionPlugin {
    if (!opts || typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
        throw new Error('devinPlugin: apiKey is required');
    }
    if (typeof opts.orgId !== 'string' || opts.orgId.length === 0) {
        throw new Error('devinPlugin: orgId is required');
    }
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const pageSize = clampPageSize(opts.pageSize ?? DEFAULT_PAGE_SIZE);
    const apiKey = opts.apiKey;
    const orgId = opts.orgId;

    return defineExtraction({
        source: 'devin',
        scope: 'extraction:devin:read',
        description: 'Fetch Devin playbooks. Targets: playbooks, playbook:{id}.',
        fetch: async (req: ExtractionRequest, ctx: ExtractionContext): Promise<ExtractionResult> => {
            const parsed = parseTarget(req.target);
            const fetchedAt = new Date().toISOString();
            const httpCtx: HttpCtx = {
                apiKey,
                baseUrl,
                timeoutMs,
                maxRetries,
                backoffBaseMs,
                log: ctx.log,
            };

            if (parsed.kind === 'playbook') {
                const url = `${baseUrl}/organizations/${encodeURIComponent(orgId)}/playbooks/${encodeURIComponent(parsed.id as string)}`;
                const res = await fetchWithRetry(url, httpCtx, { kind: 'playbook', id: parsed.id as string });
                if (res === 'not_found') {
                    ctx.log.info('Devin playbook not found', { id: parsed.id });
                    return { entries: [], fetchedAt };
                }
                const payload = (await res.json()) as DevinPlaybook;
                return { entries: [buildPlaybookEntry(payload)], fetchedAt };
            }

            // `playbooks` — paginate through every playbook in the org.
            const collected: DevinPlaybook[] = [];
            let cursor: string | undefined;
            do {
                const params = new URLSearchParams({ first: String(pageSize) });
                if (cursor) params.set('after', cursor);
                const listUrl = `${baseUrl}/organizations/${encodeURIComponent(orgId)}/playbooks?${params.toString()}`;
                const res = await fetchWithRetry(listUrl, httpCtx, { kind: 'playbooks', id: orgId });
                if (res === 'not_found') break;
                const page = (await res.json()) as DevinPaginatedResponse<DevinPlaybook>;
                for (const pb of page.items ?? []) collected.push(pb);
                if (!page.has_next_page || !page.end_cursor) break;
                cursor = page.end_cursor;
            } while (cursor);

            const entries = collected.map(buildPlaybookEntry);
            return { entries, fetchedAt };
        },
    });
}

function buildPlaybookEntry(pb: DevinPlaybook): ExtractionEntry {
    return {
        path: `playbooks/${pb.playbook_id}.json`,
        content: JSON.stringify(pb, null, 2),
        contentType: 'application/json',
    };
}

interface ParsedTarget {
    kind: 'playbooks' | 'playbook';
    id?: string;
}

function parseTarget(target: string): ParsedTarget {
    if (target === 'playbooks') return { kind: 'playbooks' };
    const idx = target.indexOf(':');
    if (idx < 0) {
        throw new Error(`devin: target must be "playbooks" or "playbook:{id}" (got ${JSON.stringify(target)})`);
    }
    const kindRaw = target.slice(0, idx);
    const id = target.slice(idx + 1).trim();
    if (kindRaw !== 'playbook') {
        throw new Error(`devin: unsupported target kind: ${kindRaw}`);
    }
    if (!id) {
        throw new Error('devin: playbook id is empty');
    }
    return { kind: 'playbook', id };
}

interface HttpCtx {
    apiKey: string;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    log: ExtractionContext['log'];
}

function fetchWithRetry(url: string, http: HttpCtx, meta: { kind: string; id: string }): Promise<Response | 'not_found'> {
    return httpFetchWithRetry(url, {
        timeoutMs: http.timeoutMs,
        maxRetries: http.maxRetries,
        backoffBaseMs: http.backoffBaseMs,
        log: http.log,
        source: 'devin',
        kind: meta.kind,
        headers: {
            Authorization: `Bearer ${http.apiKey}`,
            Accept: 'application/json',
        },
        authHint: 'apiKey and org access',
        rateLimitLabel: 'Devin',
    });
}

function clampPageSize(n: number): number {
    return httpClampPageSize(n, { max: 100, fallback: DEFAULT_PAGE_SIZE });
}
