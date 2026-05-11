/**
 * Slack extraction plugin.
 *
 * Fetches messages from Slack channels and threads via the Slack Web API
 * (https://slack.com/api/...) and shapes them into ExtractionResult entries.
 * The bot token is captured by the factory — the lib's ExtractionContext does
 * not carry credentials.
 *
 * Target syntax:
 *   - channel:{channel_id}            → recent messages via `conversations.history`
 *   - thread:{channel_id}:{thread_ts} → full thread via `conversations.replies`
 *
 * Slack API quirk: errors come back as HTTP 200 with a body of
 * `{ ok: false, error: '<reason>' }` rather than a 4xx/5xx status code.
 * We treat any `ok: false` response as a hard failure and throw with the
 * Slack error string — `invalid_auth` is handled the same way as an HTTP 401
 * would be on a more conventional API. Do not assume 200 means success.
 *
 * Failure shape contract:
 *   - 429 → wait `Retry-After` seconds (or backoff fallback), then retry
 *   - body `ok: false` → throw with the Slack error string
 *   - other non-2xx → throw; dispatcher wraps as `fetch_failed`
 *
 * The token is never logged.
 */

import {
    defineExtraction,
    type ExtractionContext,
    type ExtractionEntry,
    type ExtractionPlugin,
    type ExtractionRequest,
    type ExtractionResult,
} from '../define-extraction';

export interface SlackPluginOptions {
    token: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    backoffBaseMs?: number;
    /** Default page size for `conversations.history` (default: 200). */
    historyLimit?: number;
    /** Default page size for `conversations.replies` (default: 200). */
    repliesLimit?: number;
}

type ChannelTarget = { kind: 'channel'; channelId: string };
type ThreadTarget = { kind: 'thread'; channelId: string; threadTs: string };
type ParsedTarget = ChannelTarget | ThreadTarget;

interface SlackMessage {
    ts: string;
    text?: string;
    user?: string;
    bot_id?: string;
    username?: string;
    thread_ts?: string;
    reply_count?: number;
}

interface SlackApiOk<T> {
    ok: true;
    data: T;
}
interface SlackApiErr {
    ok: false;
    error: string;
}
type SlackApiOutcome<T> = SlackApiOk<T> | SlackApiErr;

const DEFAULT_BASE_URL = 'https://slack.com/api';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_HISTORY_LIMIT = 200;
const DEFAULT_REPLIES_LIMIT = 200;

export function slackPlugin(opts: SlackPluginOptions): ExtractionPlugin {
    if (!opts || typeof opts.token !== 'string' || opts.token.length === 0) {
        throw new Error('slackPlugin: token is required');
    }
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const historyLimit = opts.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    const repliesLimit = opts.repliesLimit ?? DEFAULT_REPLIES_LIMIT;
    const token = opts.token;

    return defineExtraction({
        source: 'slack',
        scope: 'extraction:slack:read',
        description:
            'Fetch Slack channel history and thread replies. Targets: channel:{channel_id}, thread:{channel_id}:{thread_ts}.',
        fetch: async (req: ExtractionRequest, ctx: ExtractionContext): Promise<ExtractionResult> => {
            const parsed = parseTarget(req.target);
            const fetchedAt = new Date().toISOString();

            if (parsed.kind === 'channel') {
                const messages = await fetchChannelHistory(
                    parsed.channelId,
                    { token, baseUrl, timeoutMs, maxRetries, backoffBaseMs, historyLimit, ctx },
                );
                const entry = buildChannelEntry(parsed.channelId, messages);
                return { entries: [entry], fetchedAt };
            }

            const replies = await fetchThreadReplies(
                parsed.channelId,
                parsed.threadTs,
                { token, baseUrl, timeoutMs, maxRetries, backoffBaseMs, repliesLimit, ctx },
            );
            const entry = buildThreadEntry(parsed.threadTs, replies);
            return { entries: [entry], fetchedAt };
        },
    });
}

function parseTarget(target: string): ParsedTarget {
    const firstColon = target.indexOf(':');
    if (firstColon <= 0 || firstColon === target.length - 1) {
        throw new Error(
            `slack: invalid target "${target}" (expected channel:{channel_id} or thread:{channel_id}:{thread_ts})`,
        );
    }
    const kind = target.slice(0, firstColon);
    const rest = target.slice(firstColon + 1);

    if (kind === 'channel') {
        if (!rest || rest.includes(':')) {
            throw new Error(`slack: invalid channel target "${target}" (expected channel:{channel_id})`);
        }
        return { kind: 'channel', channelId: rest };
    }

    if (kind === 'thread') {
        const sep = rest.indexOf(':');
        if (sep <= 0 || sep === rest.length - 1) {
            throw new Error(
                `slack: invalid thread target "${target}" (expected thread:{channel_id}:{thread_ts})`,
            );
        }
        const channelId = rest.slice(0, sep);
        const threadTs = rest.slice(sep + 1);
        if (!channelId || !threadTs) {
            throw new Error(`slack: invalid thread target "${target}"`);
        }
        return { kind: 'thread', channelId, threadTs };
    }

    throw new Error(`slack: unsupported target kind "${kind}"`);
}

interface BaseFetchOpts {
    token: string;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    ctx: ExtractionContext;
}

interface HistoryFetchOpts extends BaseFetchOpts {
    historyLimit: number;
}

interface RepliesFetchOpts extends BaseFetchOpts {
    repliesLimit: number;
}

async function fetchChannelHistory(
    channelId: string,
    opts: HistoryFetchOpts,
): Promise<SlackMessage[]> {
    const params = new URLSearchParams({
        channel: channelId,
        limit: String(opts.historyLimit),
    });
    const url = `${opts.baseUrl}/conversations.history?${params.toString()}`;
    const body = await slackGet<{ messages?: SlackMessage[] }>(url, opts);
    return body.messages ?? [];
}

async function fetchThreadReplies(
    channelId: string,
    threadTs: string,
    opts: RepliesFetchOpts,
): Promise<SlackMessage[]> {
    const params = new URLSearchParams({
        channel: channelId,
        ts: threadTs,
        limit: String(opts.repliesLimit),
    });
    const url = `${opts.baseUrl}/conversations.replies?${params.toString()}`;
    const body = await slackGet<{ messages?: SlackMessage[] }>(url, opts);
    return body.messages ?? [];
}

async function slackGet<T>(url: string, opts: BaseFetchOpts): Promise<T> {
    const outcome = await fetchWithRetry<T>(url, opts);
    if (!outcome.ok) {
        // Throw with the Slack-provided error string. The token is never
        // included in the message — Slack's error codes are short symbolic
        // identifiers like `invalid_auth`, `channel_not_found`, etc.
        throw new Error(`slack: api error: ${outcome.error}`);
    }
    return outcome.data;
}

async function fetchWithRetry<T>(
    url: string,
    opts: BaseFetchOpts,
): Promise<SlackApiOutcome<T>> {
    let attempt = 0;
    // attempts: 1 initial + maxRetries retries (only on 429).
    while (true) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
        let res: Response;
        try {
            res = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${opts.token}`,
                    Accept: 'application/json',
                },
                signal: controller.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            const message = err instanceof Error ? err.message : String(err);
            // Do not include the URL with query params verbatim; channel ids
            // are not secrets but the bot token is — and never appears here.
            throw new Error(`slack: network error: ${message}`);
        }
        clearTimeout(timer);

        if (res.status === 429 && attempt < opts.maxRetries) {
            const retryAfterHeader = res.headers.get('retry-after');
            const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
            const delay = Number.isFinite(retryAfterSec) && retryAfterSec > 0
                ? retryAfterSec * 1000
                : opts.backoffBaseMs * Math.pow(2, attempt);
            opts.ctx.log.warn('Slack rate limited, backing off', {
                attempt: attempt + 1,
                delayMs: delay,
                fromHeader: Number.isFinite(retryAfterSec),
            });
            attempt += 1;
            await sleep(delay);
            continue;
        }

        if (!res.ok) {
            // Non-2xx that isn't a retried 429. Slack rarely returns these for
            // logical errors (it prefers 200 + ok:false), but transport-layer
            // failures (5xx, proxy hiccups) come through here.
            throw new Error(`slack: request failed with HTTP status ${res.status}`);
        }

        // Slack-quirk: HTTP 200 does not imply success. Inspect `ok` in the body.
        const body = (await res.json()) as { ok?: unknown; error?: unknown } & Record<string, unknown>;
        if (body.ok === true) {
            return { ok: true, data: body as unknown as T };
        }
        const error = typeof body.error === 'string' && body.error.length > 0
            ? body.error
            : 'unknown_error';
        return { ok: false, error };
    }
}

function buildChannelEntry(channelId: string, messages: SlackMessage[]): ExtractionEntry {
    const lines: string[] = [
        `# Channel ${channelId}`,
        '',
        `${messages.length} message${messages.length === 1 ? '' : 's'}`,
        '',
    ];
    // Slack returns messages newest-first; render oldest-first for readability.
    const ordered = [...messages].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
    for (const msg of ordered) {
        lines.push(formatMessage(msg, 0));
    }
    return {
        path: `channels/${channelId}.md`,
        content: lines.join('\n'),
        contentType: 'text/markdown',
    };
}

function buildThreadEntry(threadTs: string, messages: SlackMessage[]): ExtractionEntry {
    const lines: string[] = [
        `# Thread ${threadTs}`,
        '',
    ];
    // `conversations.replies` returns the parent first then replies in order.
    // Render the parent at indent 0 and replies indented to convey threading.
    messages.forEach((msg, i) => {
        lines.push(formatMessage(msg, i === 0 ? 0 : 1));
    });
    return {
        path: `threads/${threadTs}.md`,
        content: lines.join('\n'),
        contentType: 'text/markdown',
    };
}

function formatMessage(msg: SlackMessage, indent: number): string {
    const user = msg.user || msg.username || msg.bot_id || 'unknown';
    const timestamp = formatTimestamp(msg.ts);
    const text = (msg.text ?? '').replace(/\r?\n/g, ' ');
    const prefix = indent > 0 ? '    '.repeat(indent) + '- ' : '- ';
    return `${prefix}${user} · ${timestamp} · ${text}`;
}

function formatTimestamp(ts: string): string {
    const seconds = parseFloat(ts);
    if (!Number.isFinite(seconds)) return ts;
    return new Date(seconds * 1000).toISOString();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
