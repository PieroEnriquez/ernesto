/**
 * Crowdin extraction plugin.
 *
 * Indexes glossaries (preferred / forbidden terms, per-language splits) and
 * style guides from Crowdin's v2 REST API at `https://api.crowdin.com/api/v2`.
 *
 * Two-source design rationale: glossaries and style guides live on separate
 * endpoints with distinct shapes, but they share an auth model and pagination
 * convention — so they live in one plugin behind discriminated targets rather
 * than two plugins with duplicated retry / pagination machinery.
 *
 * Auth model:
 *   - `Authorization: Bearer <apiKey>` on every request. Crowdin accepts
 *     account PATs and OAuth bearer tokens interchangeably for these
 *     endpoints.
 *
 * Target syntax:
 *   - `glossaries:project:<projectId>`  — every glossary visible to the project,
 *                                          one entry per glossary as
 *                                          `glossaries/<id>-<slug>.json` whose
 *                                          content is `{ glossary, terms }`
 *                                          (terms fetched across all languages).
 *   - `glossary:<glossaryId>`           — single glossary (no project filter);
 *                                          same entry shape as above.
 *   - `styleguides`                     — every style guide visible to the
 *                                          account, one entry per guide as
 *                                          `styleguides/<id>-<slug>.json`.
 *   - `styleguide:<styleguideId>`       — single style guide.
 *
 * Pagination: every list endpoint is paginated with `limit=500&offset=N` until
 * a short page is returned (Crowdin doesn't carry a "last page" flag).
 *
 * Failure shape contract:
 *   - 404 → empty entries (target absent is not a fatal error).
 *   - 429 → exponential backoff, up to 3 retries.
 *   - 401/403 → throw with a clear message; dispatcher wraps as `fetch_failed`.
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

export interface CrowdinPluginOptions {
    apiKey: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    backoffBaseMs?: number;
    /** Page size for list endpoints (1..500, Crowdin's hard ceiling). */
    pageSize?: number;
}

const DEFAULT_BASE_URL = 'https://api.crowdin.com/api/v2';
const DEFAULT_PAGE_SIZE = 500;

const GLOSSARY_CONTENT_TYPE = 'application/json';
const STYLEGUIDE_CONTENT_TYPE = 'application/json';

interface CrowdinPaginatedResponse<T> {
    data?: { data: T }[];
    pagination?: { offset?: number; limit?: number };
}

interface CrowdinGlossary {
    id: number;
    name: string;
    projectIds?: number[];
    defaultProjectId?: number;
    [key: string]: unknown;
}

interface CrowdinTerm {
    id: number;
    [key: string]: unknown;
}

interface CrowdinStyleGuide {
    id: number;
    name?: string;
    title?: string;
    [key: string]: unknown;
}

type ParsedTarget =
    | { kind: 'glossaries-project'; projectId: number }
    | { kind: 'glossary'; glossaryId: number }
    | { kind: 'styleguides' }
    | { kind: 'styleguide'; styleguideId: number };

export function crowdinPlugin(opts: CrowdinPluginOptions): ExtractionPlugin {
    if (!opts || typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
        throw new Error('crowdinPlugin: apiKey is required');
    }
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const pageSize = clampPageSize(opts.pageSize ?? DEFAULT_PAGE_SIZE);
    const apiKey = opts.apiKey;

    return defineExtraction({
        source: 'crowdin',
        scope: 'extraction:crowdin:read',
        description:
            'Fetch Crowdin glossaries and style guides. Targets: glossaries:project:{projectId}, glossary:{id}, styleguides, styleguide:{id}.',
        fetch: async (req: ExtractionRequest, ctx: ExtractionContext): Promise<ExtractionResult> => {
            const parsed = parseTarget(req.target);
            const fetchedAt = new Date().toISOString();
            const http: HttpCtx = {
                apiKey,
                baseUrl,
                timeoutMs,
                maxRetries,
                backoffBaseMs,
                pageSize,
                log: ctx.log,
            };

            if (parsed.kind === 'glossary') {
                const entry = await fetchGlossaryEntry(parsed.glossaryId, http);
                return { entries: entry ? [entry] : [], fetchedAt };
            }

            if (parsed.kind === 'styleguide') {
                const entry = await fetchStyleguideEntry(parsed.styleguideId, http);
                return { entries: entry ? [entry] : [], fetchedAt };
            }

            if (parsed.kind === 'styleguides') {
                const all = await listAll<CrowdinStyleGuide>('/style-guides', http);
                const entries: ExtractionEntry[] = [];
                for (const sg of all) entries.push(buildStyleguideEntry(sg));
                return { entries, fetchedAt };
            }

            // glossaries-project — list account-visible glossaries, filter to the
            // ones bound to this project (either via projectIds or defaultProjectId),
            // then fetch terms for each survivor.
            const all = await listAll<CrowdinGlossary>('/glossaries', http);
            const scoped = all.filter(
                (g) => (Array.isArray(g.projectIds) && g.projectIds.includes(parsed.projectId)) || g.defaultProjectId === parsed.projectId,
            );
            const entries: ExtractionEntry[] = [];
            for (const glossary of scoped) {
                const entry = await assembleGlossaryEntry(glossary, http);
                entries.push(entry);
            }
            return { entries, fetchedAt };
        },
    });
}

function parseTarget(target: string): ParsedTarget {
    if (target === 'styleguides') return { kind: 'styleguides' };
    const idx = target.indexOf(':');
    if (idx < 0) {
        throw new Error('crowdin: target must be "glossaries:project:{id}", "glossary:{id}", "styleguides", or "styleguide:{id}"');
    }
    const kind = target.slice(0, idx);
    const rest = target.slice(idx + 1).trim();
    if (!rest) throw new Error('crowdin: target id is empty');

    if (kind === 'glossaries') {
        // "project:{id}" sub-target. The "glossaries" alone case is rejected
        // because we never index the union of every account-visible glossary
        // — that's not a use case we want to encourage, and it would silently
        // grow unbounded.
        const subIdx = rest.indexOf(':');
        if (subIdx < 0) {
            throw new Error('crowdin: glossaries target must be "glossaries:project:{projectId}"');
        }
        const sub = rest.slice(0, subIdx);
        const subId = rest.slice(subIdx + 1).trim();
        if (sub !== 'project') {
            throw new Error(`crowdin: unsupported glossaries sub-target: ${sub}`);
        }
        const projectId = parseInt(subId, 10);
        if (!Number.isFinite(projectId)) {
            throw new Error(`crowdin: invalid projectId: ${subId}`);
        }
        return { kind: 'glossaries-project', projectId };
    }
    if (kind === 'glossary') {
        const glossaryId = parseInt(rest, 10);
        if (!Number.isFinite(glossaryId)) {
            throw new Error(`crowdin: invalid glossaryId: ${rest}`);
        }
        return { kind: 'glossary', glossaryId };
    }
    if (kind === 'styleguide') {
        const styleguideId = parseInt(rest, 10);
        if (!Number.isFinite(styleguideId)) {
            throw new Error(`crowdin: invalid styleguideId: ${rest}`);
        }
        return { kind: 'styleguide', styleguideId };
    }
    throw new Error(`crowdin: unsupported target kind: ${kind}`);
}

async function fetchGlossaryEntry(glossaryId: number, http: HttpCtx): Promise<ExtractionEntry | null> {
    // The /glossaries/{id} endpoint exists but doesn't include terms; we
    // still need the listing call to discover the glossary name reliably,
    // and the terms endpoint is separate. Cheaper to walk the listing once
    // and slice the matching glossary out of memory than to fire two calls.
    const all = await listAll<CrowdinGlossary>('/glossaries', http);
    const glossary = all.find((g) => g.id === glossaryId);
    if (!glossary) return null;
    return assembleGlossaryEntry(glossary, http);
}

async function assembleGlossaryEntry(glossary: CrowdinGlossary, http: HttpCtx): Promise<ExtractionEntry> {
    const terms = await listAll<CrowdinTerm>(`/glossaries/${encodeURIComponent(String(glossary.id))}/terms`, http);
    return {
        path: `glossaries/${glossary.id}-${slugify(glossary.name) || glossary.id}.json`,
        content: JSON.stringify({ glossary, terms }, null, 2),
        contentType: GLOSSARY_CONTENT_TYPE,
    };
}

async function fetchStyleguideEntry(styleguideId: number, http: HttpCtx): Promise<ExtractionEntry | null> {
    const all = await listAll<CrowdinStyleGuide>('/style-guides', http);
    const sg = all.find((g) => g.id === styleguideId);
    if (!sg) return null;
    return buildStyleguideEntry(sg);
}

function buildStyleguideEntry(sg: CrowdinStyleGuide): ExtractionEntry {
    const display = sg.title || sg.name || String(sg.id);
    return {
        path: `styleguides/${sg.id}-${slugify(display) || sg.id}.json`,
        content: JSON.stringify(sg, null, 2),
        contentType: STYLEGUIDE_CONTENT_TYPE,
    };
}

interface HttpCtx {
    apiKey: string;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    pageSize: number;
    log: ExtractionContext['log'];
}

/**
 * Walk every page of a `limit/offset`-paginated Crowdin list endpoint until a
 * page comes back shorter than `pageSize` (Crowdin doesn't return a `last_page`
 * flag, so the empty / short-page convention is the only reliable terminator).
 *
 * Returns `[]` on 404 (the endpoint may legitimately be empty on the account's
 * plan — style guides in particular are gated by the Crowdin plan).
 *
 * `path` should NOT include a leading `?` — query params are composed here.
 */
async function listAll<T>(path: string, http: HttpCtx): Promise<T[]> {
    const collected: T[] = [];
    let offset = 0;
    while (true) {
        const params = new URLSearchParams({
            limit: String(http.pageSize),
            offset: String(offset),
        });
        const url = `${http.baseUrl}${path}?${params.toString()}`;
        const res = await fetchWithRetry(url, http, { kind: path, id: String(offset) });
        if (res === 'not_found') return collected;
        const payload = (await res.json()) as CrowdinPaginatedResponse<T>;
        const page = (payload.data ?? []).map((d) => d.data);
        for (const item of page) collected.push(item);
        if (page.length < http.pageSize) break;
        offset += http.pageSize;
    }
    return collected;
}

function fetchWithRetry(url: string, http: HttpCtx, meta: { kind: string; id: string }): Promise<Response | 'not_found'> {
    return httpFetchWithRetry(url, {
        timeoutMs: http.timeoutMs,
        maxRetries: http.maxRetries,
        backoffBaseMs: http.backoffBaseMs,
        log: http.log,
        source: 'crowdin',
        kind: meta.kind,
        headers: {
            Authorization: `Bearer ${http.apiKey}`,
            Accept: 'application/json',
        },
        authHint: 'apiKey and scopes',
        rateLimitLabel: 'Crowdin',
    });
}

function clampPageSize(n: number): number {
    return httpClampPageSize(n, { max: 500, fallback: DEFAULT_PAGE_SIZE });
}

function slugify(name: string | number | undefined): string {
    if (name === undefined || name === null) return '';
    return String(name)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s-]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}
