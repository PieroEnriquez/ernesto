/**
 * ClickUp extraction plugin.
 *
 * Fetches tasks, lists, and docs from ClickUp's REST API
 * (https://api.clickup.com/api/v2/...) and shapes them into ExtractionResult
 * entries. Token is captured by the factory — the lib's ExtractionContext does
 * not carry credentials.
 *
 * Target syntax (matches frontmatter convention):
 *   - task:{id}           → tasks/{id}.json (raw JSON)
 *   - list:{id}           → lists/{id}.json (raw JSON list metadata)
 *   - doc:{id}            → docs/{id}.md   (markdown content)
 *   - list-table:{id}     → lists/{id}.md  (markdown table of tasks, legacy
 *                            ClickUpListFormat parity; closed tasks older than
 *                            ~3 months are dropped)
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
    /**
     * Cutoff (in months) for closed tasks rendered by `list-table:` targets.
     * Closed tasks whose `date_closed` (or `date_updated`) is older than
     * `now - closedTaskCutoffMonths` months are excluded. Matches the legacy
     * ClickUpListFormat behaviour. Defaults to 3.
     */
    closedTaskCutoffMonths?: number;
}

type TargetKind = 'task' | 'list' | 'doc' | 'list-table';

const DEFAULT_BASE_URL = 'https://api.clickup.com/api/v2';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_CLOSED_TASK_CUTOFF_MONTHS = 3;

const CLOSED_STATUS_NAMES = new Set([
    'closed',
    'done',
    'complete',
    'completed',
    'resolved',
    'cancelled',
    'canceled',
    'archived',
]);

interface ClickUpTask {
    id: string;
    custom_id?: string | null;
    name: string;
    status?: { status?: string; type?: string } | null;
    assignees?: { username?: string }[];
    tags?: { name?: string }[];
    priority?: { priority?: string } | null;
    date_created?: string | null;
    date_updated?: string | null;
    date_closed?: string | null;
    url?: string | null;
}

export function clickupPlugin(opts: ClickUpPluginOptions): ExtractionPlugin {
    if (!opts.token || typeof opts.token !== 'string') {
        throw new Error('clickupPlugin: token is required');
    }
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const closedTaskCutoffMonths =
        opts.closedTaskCutoffMonths ?? DEFAULT_CLOSED_TASK_CUTOFF_MONTHS;
    const token = opts.token;

    return defineExtraction({
        source: 'clickup',
        scope: 'extraction:clickup:read',
        description:
            'Fetch ClickUp tasks, lists, and docs by id. Targets: task:{id}, list:{id}, doc:{id}, list-table:{id}.',
        fetch: async (req: ExtractionRequest, ctx: ExtractionContext): Promise<ExtractionResult> => {
            const parsed = parseTarget(req.target);
            const fetchedAt = new Date().toISOString();

            if (parsed.kind === 'list-table') {
                const entry = await fetchListTable({
                    id: parsed.id,
                    token,
                    baseUrl,
                    timeoutMs,
                    maxRetries,
                    backoffBaseMs,
                    closedTaskCutoffMonths,
                    log: ctx.log,
                });
                if (!entry) {
                    ctx.log.info('ClickUp target not found', { kind: parsed.kind });
                    return { entries: [], fetchedAt };
                }
                return { entries: [entry], fetchedAt };
            }

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
            `clickup: target must look like "task:{id}", "list:{id}", "doc:{id}", or "list-table:{id}"`,
        );
    }
    const kindRaw = target.slice(0, idx);
    const id = target.slice(idx + 1).trim();
    if (!id) {
        throw new Error('clickup: target id is empty');
    }
    if (
        kindRaw !== 'task' &&
        kindRaw !== 'list' &&
        kindRaw !== 'doc' &&
        kindRaw !== 'list-table'
    ) {
        throw new Error(`clickup: unsupported target kind: ${kindRaw}`);
    }
    return { kind: kindRaw, id };
}

function endpointFor(kind: Exclude<TargetKind, 'list-table'>, id: string, baseUrl: string): string {
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
    kind: Exclude<TargetKind, 'list-table'>,
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

interface FetchListTableArgs {
    id: string;
    token: string;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    closedTaskCutoffMonths: number;
    log: ExtractionContext['log'];
}

async function fetchListTable(args: FetchListTableArgs): Promise<ExtractionEntry | null> {
    const safe = encodeURIComponent(args.id);

    // 1. Fetch list metadata (for the title).
    const listRes = await fetchWithRetry(`${args.baseUrl}/list/${safe}`, args.token, {
        timeoutMs: args.timeoutMs,
        maxRetries: args.maxRetries,
        backoffBaseMs: args.backoffBaseMs,
        log: args.log,
        kind: 'list-table',
        id: args.id,
    });
    if (listRes === 'not_found') {
        return null;
    }
    const listPayload = (await listRes.json()) as { id?: string; name?: string };
    const listName = typeof listPayload.name === 'string' ? listPayload.name : args.id;

    // 2. Fetch tasks for the list. Include subtasks for parity with legacy.
    const tasksRes = await fetchWithRetry(
        `${args.baseUrl}/list/${safe}/task?subtasks=true&include_closed=true`,
        args.token,
        {
            timeoutMs: args.timeoutMs,
            maxRetries: args.maxRetries,
            backoffBaseMs: args.backoffBaseMs,
            log: args.log,
            kind: 'list-table',
            id: args.id,
        },
    );
    // If the tasks endpoint 404s but the list exists, treat as an empty list.
    const tasks: ClickUpTask[] =
        tasksRes === 'not_found'
            ? []
            : (((await tasksRes.json()) as { tasks?: ClickUpTask[] }).tasks ?? []);

    const cutoffMs = computeClosedCutoffMs(args.closedTaskCutoffMonths);
    const filtered = tasks.filter((t) => !isStaleClosedTask(t, cutoffMs));

    const markdown = renderTaskTable(listName, args.id, filtered);

    return {
        path: `lists/${args.id}.md`,
        content: markdown,
        contentType: 'text/markdown',
    };
}

function computeClosedCutoffMs(months: number): number {
    if (!Number.isFinite(months) || months <= 0) {
        return 0;
    }
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - months);
    return cutoff.getTime();
}

function isStaleClosedTask(task: ClickUpTask, cutoffMs: number): boolean {
    if (cutoffMs <= 0) return false;
    const statusName = (task.status?.status ?? '').toLowerCase();
    const statusType = task.status?.type;
    const isClosed = statusType === 'closed' || CLOSED_STATUS_NAMES.has(statusName);
    if (!isClosed) return false;

    const tsStr = task.date_closed || task.date_updated;
    if (!tsStr) return false;
    const ts = parseInt(String(tsStr), 10);
    if (!Number.isFinite(ts)) return false;
    return ts < cutoffMs;
}

function renderTaskTable(listName: string, listId: string, tasks: ClickUpTask[]): string {
    const header = `# ${listName}\n\nList ID: ${listId}\n`;

    if (tasks.length === 0) {
        return `${header}\n_No tasks._\n`;
    }

    const columns = [
        'ID',
        'Name',
        'Status',
        'Assignees',
        'Priority',
        'Tags',
        'Updated',
        'URL',
    ];
    const rows: string[] = [];
    rows.push(`| ${columns.join(' | ')} |`);
    rows.push(`| ${columns.map(() => '---').join(' | ')} |`);

    for (const t of tasks) {
        rows.push(
            `| ${[
                escapeCell(t.custom_id || t.id),
                escapeCell(t.name ?? ''),
                escapeCell(t.status?.status ?? ''),
                escapeCell((t.assignees ?? []).map((a) => a.username ?? '').filter(Boolean).join(', ')),
                escapeCell(t.priority?.priority ?? ''),
                escapeCell((t.tags ?? []).map((tag) => tag.name ?? '').filter(Boolean).join(', ')),
                escapeCell(formatTimestamp(t.date_updated)),
                escapeCell(t.url ?? `https://app.clickup.com/t/${t.id}`),
            ].join(' | ')} |`,
        );
    }

    return `${header}\n${rows.join('\n')}\n`;
}

function escapeCell(value: string): string {
    return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatTimestamp(ts: string | null | undefined): string {
    if (!ts) return '';
    const n = parseInt(String(ts), 10);
    if (!Number.isFinite(n)) return '';
    try {
        return new Date(n).toISOString();
    } catch {
        return '';
    }
}

function stringifyJson(payload: unknown): string {
    return JSON.stringify(payload, null, 2);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
