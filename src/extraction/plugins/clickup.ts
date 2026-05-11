/**
 * ClickUp extraction plugin.
 *
 * Fetches tasks, lists, and docs from ClickUp's REST API
 * (https://api.clickup.com/api/v2/...) and shapes them into ExtractionResult
 * entries. Token is captured by the factory — the lib's ExtractionContext does
 * not carry credentials.
 *
 * Target syntax (matches frontmatter convention):
 *   - task:{id}
 *   - list:{id}
 *   - doc:{id}
 *
 * Failure shape contract:
 *   - 404 → resolve with empty entries (target absent is not a fatal error)
 *   - 429 → exponential backoff, up to 3 retries
 *   - other non-2xx → throw; dispatcher wraps as `fetch_failed`
 */

import {
    defineExtraction,
    type ExtractionContext,
    type ExtractionEntry,
    type ExtractionPlugin,
    type ExtractionRequest,
    type ExtractionResult,
} from '../define-extraction';

export interface ClickUpPluginOptions {
    token: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    backoffBaseMs?: number;
}

type TargetKind = 'task' | 'list' | 'doc';

const DEFAULT_BASE_URL = 'https://api.clickup.com/api/v2';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;

export function clickupPlugin(opts: ClickUpPluginOptions): ExtractionPlugin {
    if (!opts.token || typeof opts.token !== 'string') {
        throw new Error('clickupPlugin: token is required');
    }
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const token = opts.token;

    return defineExtraction({
        source: 'clickup',
        scope: 'extraction:clickup:read',
        description:
            'Fetch ClickUp tasks, lists, and docs by id. Targets: task:{id}, list:{id}, doc:{id}.',
        fetch: async (req: ExtractionRequest, ctx: ExtractionContext): Promise<ExtractionResult> => {
            const parsed = parseTarget(req.target);
            const fetchedAt = new Date().toISOString();

            const endpoint = endpointFor(parsed.kind, parsed.id, baseUrl);
            const response = await fetchWithRetry(endpoint, token, {
                timeoutMs,
                maxRetries,
                backoffBaseMs,
                log: ctx.log,
                kind: parsed.kind,
                id: parsed.id,
            });

            if (response === 'not_found') {
                ctx.log.info('ClickUp target not found', { kind: parsed.kind });
                return { entries: [], fetchedAt };
            }

            const entry = await buildEntry(parsed.kind, parsed.id, response);
            return { entries: [entry], fetchedAt };
        },
    });
}

function parseTarget(target: string): { kind: TargetKind; id: string } {
    const idx = target.indexOf(':');
    if (idx < 0) {
        throw new Error(
            `clickup: target must look like "task:{id}", "list:{id}", or "doc:{id}"`,
        );
    }
    const kindRaw = target.slice(0, idx);
    const id = target.slice(idx + 1).trim();
    if (!id) {
        throw new Error('clickup: target id is empty');
    }
    if (kindRaw !== 'task' && kindRaw !== 'list' && kindRaw !== 'doc') {
        throw new Error(`clickup: unsupported target kind: ${kindRaw}`);
    }
    return { kind: kindRaw, id };
}

function endpointFor(kind: TargetKind, id: string, baseUrl: string): string {
    const safe = encodeURIComponent(id);
    switch (kind) {
        case 'task':
            return `${baseUrl}/task/${safe}`;
        case 'list':
            return `${baseUrl}/list/${safe}`;
        case 'doc':
            return `${baseUrl}/doc/${safe}`;
    }
}

interface FetchWithRetryOpts {
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    log: ExtractionContext['log'];
    kind: TargetKind;
    id: string;
}

async function fetchWithRetry(
    url: string,
    token: string,
    opts: FetchWithRetryOpts,
): Promise<Response | 'not_found'> {
    let attempt = 0;
    // attempts: 1 initial + maxRetries retries
    while (true) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
        let res: Response;
        try {
            res = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: 'application/json',
                },
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`clickup: network error fetching ${opts.kind}: ${message}`);
        }
        clearTimeout(timer);

        if (res.status === 404) {
            return 'not_found';
        }

        if (res.status === 429 && attempt < opts.maxRetries) {
            const delay = opts.backoffBaseMs * Math.pow(2, attempt);
            opts.log.warn('ClickUp rate limited, backing off', {
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
                `clickup: auth rejected (status ${res.status}) for ${opts.kind} — check token and scopes`,
            );
        }

        if (!res.ok) {
            throw new Error(`clickup: ${opts.kind} fetch failed with status ${res.status}`);
        }

        return res;
    }
}

async function buildEntry(
    kind: TargetKind,
    id: string,
    response: Response,
): Promise<ExtractionEntry> {
    if (kind === 'doc') {
        const payload = (await response.json()) as { content?: unknown; name?: unknown };
        const content =
            typeof payload.content === 'string'
                ? payload.content
                : stringifyJson(payload);
        return {
            path: `docs/${id}.md`,
            content,
            contentType: 'text/markdown',
        };
    }

    const payload = (await response.json()) as unknown;
    return {
        path: `${kind === 'task' ? 'tasks' : 'lists'}/${id}.json`,
        content: stringifyJson(payload),
        contentType: 'application/json',
    };
}

function stringifyJson(payload: unknown): string {
    return JSON.stringify(payload, null, 2);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
