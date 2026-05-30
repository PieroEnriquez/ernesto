/**
 * Qase extraction plugin.
 *
 * Fetches test suites and cases from Qase's REST API
 * (https://api.qase.io/v1/...) and shapes them into ExtractionResult entries.
 * Token is captured by the factory — the lib's ExtractionContext does not
 * carry credentials, and the token is never logged.
 *
 * Auth model:
 *   - Qase uses a custom `Token: <token>` header (NOT `Authorization: Bearer`).
 *
 * Target syntax (matches frontmatter convention):
 *   - `project:<projectCode>`              — list of suites in the project.
 *   - `suite:<projectCode>:<suiteId>`      — every case in a suite.
 *   - `case:<projectCode>:<caseId>`        — a single test case.
 *
 * Response envelope:
 *   - Qase wraps successful responses as `{ status: true, result: <payload> }`.
 *     The plugin unwraps `result` for entry content; if the envelope is
 *     missing the raw payload is used as-is.
 *
 * Failure shape contract:
 *   - 404 → resolve with empty entries (target absent is not a fatal error).
 *   - 429 → exponential backoff, up to 3 retries.
 *   - 401/403 → throw with a clear message; dispatcher wraps as `fetch_failed`.
 *   - other non-2xx → throw; dispatcher wraps as `fetch_failed`.
 *
 * Network:
 *   - 30s timeout per HTTP call.
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
    stringifyJson,
} from './_http';

export interface QasePluginOptions {
    token: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    backoffBaseMs?: number;
    /** Page size used when fetching all cases in a suite (1..100). */
    pageSize?: number;
}

type TargetKind = 'project' | 'suite' | 'case';

interface ParsedTarget {
    kind: TargetKind;
    projectCode: string;
    /** Set for `suite` and `case`. */
    id?: string;
}

const DEFAULT_BASE_URL = 'https://api.qase.io/v1';
const DEFAULT_PAGE_SIZE = 100;

export function qasePlugin(opts: QasePluginOptions): ExtractionPlugin {
    if (!opts || typeof opts.token !== 'string' || opts.token.length === 0) {
        throw new Error('qasePlugin: token is required');
    }
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const pageSize = clampPageSize(opts.pageSize ?? DEFAULT_PAGE_SIZE);
    const token = opts.token;

    return defineExtraction({
        source: 'qase',
        scope: 'extraction:qase:read',
        description:
            'Fetch Qase test suites and cases. Targets: project:{code}, suite:{code}:{suiteId}, case:{code}:{caseId}.',
        fetch: async (
            req: ExtractionRequest,
            ctx: ExtractionContext,
        ): Promise<ExtractionResult> => {
            const target = parseTarget(req.target);
            const fetchedAt = new Date().toISOString();
            const httpOpts = {
                baseUrl,
                token,
                timeoutMs,
                maxRetries,
                backoffBaseMs,
                ctx,
            };

            if (target.kind === 'case') {
                const endpoint = `${baseUrl}/case/${encodeURIComponent(target.projectCode)}/${encodeURIComponent(target.id!)}`;
                const res = await qaseRequest(endpoint, httpOpts, { kind: 'case', id: target.id! });
                if (res === 'not_found') {
                    ctx.log.info('Qase target not found', { kind: 'case' });
                    return { entries: [], fetchedAt };
                }
                const payload = unwrapResult(res);
                const entry: ExtractionEntry = {
                    path: `cases/${target.id}.json`,
                    content: stringifyJson(payload),
                    contentType: 'application/json',
                };
                return { entries: [entry], fetchedAt };
            }

            if (target.kind === 'suite') {
                // Fetch the suite metadata + every case belonging to that suite.
                const suiteEndpoint = `${baseUrl}/suite/${encodeURIComponent(target.projectCode)}/${encodeURIComponent(target.id!)}`;
                const suiteRes = await qaseRequest(suiteEndpoint, httpOpts, {
                    kind: 'suite',
                    id: target.id!,
                });
                if (suiteRes === 'not_found') {
                    ctx.log.info('Qase target not found', { kind: 'suite' });
                    return { entries: [], fetchedAt };
                }
                const suitePayload = unwrapResult(suiteRes);

                const cases = await fetchAllCasesInSuite(
                    target.projectCode,
                    target.id!,
                    pageSize,
                    httpOpts,
                );

                const entries: ExtractionEntry[] = [
                    {
                        path: `suites/${target.id}.json`,
                        content: stringifyJson(suitePayload),
                        contentType: 'application/json',
                    },
                    ...cases.map((c) => ({
                        path: `cases/${getCaseId(c)}.json`,
                        content: stringifyJson(c),
                        contentType: 'application/json',
                    })),
                ];
                return { entries, fetchedAt };
            }

            // project: list all suites in the project.
            const projectEndpoint = `${baseUrl}/suite/${encodeURIComponent(target.projectCode)}`;
            const res = await qaseRequest(projectEndpoint, httpOpts, {
                kind: 'project',
                id: target.projectCode,
            });
            if (res === 'not_found') {
                ctx.log.info('Qase target not found', { kind: 'project' });
                return { entries: [], fetchedAt };
            }
            const payload = unwrapResult(res);
            const entry: ExtractionEntry = {
                path: `projects/${target.projectCode}/suites.json`,
                content: stringifyJson(payload),
                contentType: 'application/json',
            };
            return { entries: [entry], fetchedAt };
        },
    });
}

function parseTarget(target: string): ParsedTarget {
    const parts = target.split(':');
    if (parts.length < 2 || parts.some((p) => p.length === 0)) {
        throw new Error(
            `qase: target must look like "project:{code}", "suite:{code}:{suiteId}", or "case:{code}:{caseId}"`,
        );
    }
    const kindRaw = parts[0];
    if (kindRaw !== 'project' && kindRaw !== 'suite' && kindRaw !== 'case') {
        throw new Error(`qase: unsupported target kind: ${kindRaw}`);
    }

    if (kindRaw === 'project') {
        if (parts.length !== 2) {
            throw new Error('qase: project target must be "project:{code}"');
        }
        return { kind: 'project', projectCode: parts[1] };
    }

    if (parts.length !== 3) {
        throw new Error(
            `qase: ${kindRaw} target must be "${kindRaw}:{code}:{id}"`,
        );
    }
    return { kind: kindRaw, projectCode: parts[1], id: parts[2] };
}

interface HttpOpts {
    baseUrl: string;
    token: string;
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    ctx: ExtractionContext;
}

interface CallMeta {
    kind: TargetKind;
    id: string;
}

async function qaseRequest(
    url: string,
    opts: HttpOpts,
    meta: CallMeta,
): Promise<unknown | 'not_found'> {
    const res = await httpFetchWithRetry(url, {
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        backoffBaseMs: opts.backoffBaseMs,
        log: opts.ctx.log,
        source: 'qase',
        kind: meta.kind,
        // Qase uses a custom `Token: <token>` header, NOT `Authorization: Bearer`.
        headers: {
            Token: opts.token,
            Accept: 'application/json',
        },
        authHint: 'token and scopes',
        rateLimitLabel: 'Qase',
    });
    if (res === 'not_found') {
        return 'not_found';
    }
    return (await res.json()) as unknown;
}

async function fetchAllCasesInSuite(
    projectCode: string,
    suiteId: string,
    pageSize: number,
    opts: HttpOpts,
): Promise<unknown[]> {
    const out: unknown[] = [];
    let offset = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const params = new URLSearchParams({
            suite_id: suiteId,
            limit: String(pageSize),
            offset: String(offset),
        });
        const url = `${opts.baseUrl}/case/${encodeURIComponent(projectCode)}?${params.toString()}`;
        const res = await qaseRequest(url, opts, { kind: 'suite', id: suiteId });
        if (res === 'not_found') {
            // A 404 on the cases listing means the suite has nothing addressable —
            // treat it as "no more pages" and return whatever we've already gathered.
            return out;
        }
        const result = unwrapResult(res) as {
            entities?: unknown[];
            count?: number;
            filtered?: number;
            total?: number;
        };
        const page = Array.isArray(result.entities) ? result.entities : [];
        out.push(...page);

        const filtered =
            typeof result.filtered === 'number' ? result.filtered : undefined;
        const fetchedCount = page.length;
        if (fetchedCount === 0) break;
        if (filtered !== undefined && out.length >= filtered) break;
        if (fetchedCount < pageSize) break;

        offset += pageSize;
    }

    return out;
}

function unwrapResult(payload: unknown): unknown {
    if (
        payload !== null &&
        typeof payload === 'object' &&
        'status' in payload &&
        'result' in payload &&
        (payload as { status: unknown }).status === true
    ) {
        return (payload as { result: unknown }).result;
    }
    return payload;
}

function getCaseId(testCase: unknown): string {
    if (
        testCase !== null &&
        typeof testCase === 'object' &&
        'id' in testCase
    ) {
        const id = (testCase as { id: unknown }).id;
        if (typeof id === 'number' || typeof id === 'string') {
            return String(id);
        }
    }
    return 'unknown';
}

function clampPageSize(n: number): number {
    return httpClampPageSize(n, { max: 100, fallback: DEFAULT_PAGE_SIZE, rejectNonPositive: true });
}
