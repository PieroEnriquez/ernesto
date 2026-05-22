/**
 * Slack extraction plugin.
 *
 * Fetches messages from Slack channels and threads via the Slack Web API
 * (https://slack.com/api/...) and shapes them into ExtractionResult entries.
 * The bot token is captured by the factory — the lib's ExtractionContext does
 * not carry credentials.
 *
 * Target syntax:
 *   - channel:{channel_id}                   → recent messages via `conversations.history`
 *                                              (one entry per channel, flat history).
 *   - thread:{channel_id}:{thread_ts}        → full thread via `conversations.replies`
 *                                              (one entry per thread).
 *   - channel-threads:{channel_id}[:{days}]  → walk a channel for the last `days`
 *                                              days (default 30) and emit
 *                                              **one entry per thread**. Single
 *                                              messages with no replies are
 *                                              skipped — `channel:` covers
 *                                              flat chatter; this target is for
 *                                              thread-as-document indexing.
 *                                              Each entry lands at
 *                                              `threads/{YYYY-MM-DD}-{slug}-{ts}.md`
 *                                              with a typed frontmatter block.
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
type ChannelThreadsTarget = { kind: 'channel-threads'; channelId: string; daysBack: number };
type ParsedTarget = ChannelTarget | ThreadTarget | ChannelThreadsTarget;

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
/** Default cutoff window for `channel-threads:{id}` with no `:N` suffix. */
const DEFAULT_CHANNEL_THREADS_DAYS_BACK = 30;

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
            'Fetch Slack channel history and thread replies. Targets: channel:{channel_id}, thread:{channel_id}:{thread_ts}, channel-threads:{channel_id}[:{days}].',
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

            if (parsed.kind === 'thread') {
                const replies = await fetchThreadReplies(
                    parsed.channelId,
                    parsed.threadTs,
                    { token, baseUrl, timeoutMs, maxRetries, backoffBaseMs, repliesLimit, ctx },
                );
                const entry = buildThreadEntry(parsed.threadTs, replies);
                return { entries: [entry], fetchedAt };
            }

            // channel-threads: walk paginated history within the cutoff,
            // fan out every thread parent through conversations.replies,
            // emit one document per thread. Single messages with no
            // replies are deliberately dropped — they belong to the
            // `channel:` target.
            const oldestUnix = nowUnixSeconds() - parsed.daysBack * SECONDS_PER_DAY;
            const parents = await fetchChannelThreadParents(parsed.channelId, oldestUnix, {
                token, baseUrl, timeoutMs, maxRetries, backoffBaseMs, historyLimit, ctx,
            });
            const entries: ExtractionEntry[] = [];
            for (const parent of parents) {
                const replies = await fetchThreadReplies(
                    parsed.channelId,
                    parent.ts,
                    { token, baseUrl, timeoutMs, maxRetries, backoffBaseMs, repliesLimit, ctx },
                );
                if (replies.length === 0) continue;
                entries.push(buildChannelThreadEntry(parsed.channelId, replies, fetchedAt));
            }
            ctx.log.info('Slack channel-threads extraction complete', {
                channelId: parsed.channelId,
                daysBack: parsed.daysBack,
                parentsScanned: parents.length,
                threadsEmitted: entries.length,
            });
            return { entries, fetchedAt };
        },
    });
}

const SECONDS_PER_DAY = 24 * 60 * 60;

function nowUnixSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

function parseTarget(target: string): ParsedTarget {
    const firstColon = target.indexOf(':');
    if (firstColon <= 0 || firstColon === target.length - 1) {
        throw new Error(
            `slack: invalid target "${target}" (expected channel:{channel_id}, thread:{channel_id}:{thread_ts}, or channel-threads:{channel_id}[:{days}])`,
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

    if (kind === 'channel-threads') {
        const sep = rest.indexOf(':');
        if (sep < 0) {
            // No `:N` → default cutoff window.
            return {
                kind: 'channel-threads',
                channelId: rest,
                daysBack: DEFAULT_CHANNEL_THREADS_DAYS_BACK,
            };
        }
        const channelId = rest.slice(0, sep);
        const daysStr = rest.slice(sep + 1);
        if (!channelId || !daysStr) {
            throw new Error(
                `slack: invalid channel-threads target "${target}" (expected channel-threads:{channel_id}[:{days}])`,
            );
        }
        const daysBack = Number(daysStr);
        if (!Number.isFinite(daysBack) || !Number.isInteger(daysBack) || daysBack <= 0) {
            throw new Error(
                `slack: invalid channel-threads target "${target}" — days must be a positive integer`,
            );
        }
        return { kind: 'channel-threads', channelId, daysBack };
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

/**
 * Walk `conversations.history` for the given channel, paginating with
 * `cursor` until the response covers everything newer than `oldestUnix`.
 * Returns only messages that are thread parents (`reply_count > 0`); the
 * caller fans each one out via `conversations.replies`.
 *
 * Slack's pagination behavior: `oldest=<unix>` is inclusive, results are
 * newest-first. We pass the bound on the first call and rely on the
 * response's `has_more` + `response_metadata.next_cursor` for subsequent
 * pages. Slack itself honors the cutoff per page, so no client-side
 * trimming is needed — but we still guard against runaway loops via a
 * page cap proportional to how much data could fit in the window.
 */
async function fetchChannelThreadParents(
    channelId: string,
    oldestUnix: number,
    opts: HistoryFetchOpts,
): Promise<SlackMessage[]> {
    const parents: SlackMessage[] = [];
    let cursor: string | undefined;
    let pages = 0;
    // Hard cap: at 200 msgs/page this gives 100 pages = 20k messages.
    // Tighter than Slack's open-ended pagination would allow on a
    // talkative channel with a too-wide window, but loud at the seam.
    const MAX_PAGES = 100;

    while (true) {
        if (pages >= MAX_PAGES) {
            opts.ctx.log.warn(
                'Slack channel-threads: pagination cap hit, stopping early',
                { channelId, pages, oldestUnix },
            );
            break;
        }
        const params = new URLSearchParams({
            channel: channelId,
            limit: String(opts.historyLimit),
            oldest: String(oldestUnix),
            inclusive: 'true',
        });
        if (cursor) params.set('cursor', cursor);
        const url = `${opts.baseUrl}/conversations.history?${params.toString()}`;
        const body = await slackGet<{
            messages?: SlackMessage[];
            has_more?: boolean;
            response_metadata?: { next_cursor?: string };
        }>(url, opts);
        const batch = body.messages ?? [];
        for (const msg of batch) {
            if (isThreadParent(msg)) parents.push(msg);
        }
        pages += 1;
        const nextCursor = body.response_metadata?.next_cursor;
        if (!body.has_more || !nextCursor) break;
        cursor = nextCursor;
    }
    return parents;
}

/**
 * A message is a thread parent when it has at least one reply. Slack
 * surfaces this two ways:
 *   - `reply_count > 0` (preferred, present on parents from history)
 *   - `thread_ts === ts` and `thread_ts` is set (defensive — applies
 *     when Slack omits reply_count on edge events)
 * A message with no `thread_ts` and no `reply_count` is a flat message
 * that never spawned a thread and is skipped here.
 */
function isThreadParent(msg: SlackMessage): boolean {
    if (typeof msg.reply_count === 'number' && msg.reply_count > 0) return true;
    if (msg.thread_ts && msg.thread_ts === msg.ts) return true;
    return false;
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

/**
 * Build one document for a thread, including a frontmatter block with
 * canonical metadata (uri, source_id, participants, first/last ts,
 * reply count). The path encodes `{YYYY-MM-DD}-{slug}-{ts}.md` —
 * chronological sort by ls, slug for Grep navigation, ts as the stable
 * anchor that survives slug churn. See §5 of `domains/workspaces/README.md`.
 */
function buildChannelThreadEntry(
    channelId: string,
    messages: SlackMessage[],
    fetchedAt: string,
): ExtractionEntry {
    // `conversations.replies` returns the parent first, then replies in
    // posting order. The first element is the canonical thread anchor.
    const parent = messages[0];
    const last = messages[messages.length - 1];
    const threadTs = parent.ts;
    const startedAt = formatTimestamp(parent.ts);
    const lastReplyAt = formatTimestamp(last.ts);

    const participants = Array.from(new Set(
        messages
            .map((m) => m.user || m.bot_id || m.username)
            .filter((u): u is string => typeof u === 'string' && u.length > 0),
    ));

    const headline = oneLine(parent.text ?? '', 80);
    const slug = slugify(parent.text ?? '', 40);
    const dateYmd = formatDateYmd(parent.ts);

    const frontmatter = [
        '---',
        `uri: slack://thread/${channelId}/${threadTs}`,
        `source: slack`,
        `type: thread`,
        `source_id: ${channelId}/${threadTs}`,
        `channel_id: ${channelId}`,
        `started_at: ${startedAt}`,
        `last_reply_at: ${lastReplyAt}`,
        `reply_count: ${Math.max(0, messages.length - 1)}`,
        `participants: [${participants.join(', ')}]`,
        `indexed_at: ${fetchedAt}`,
        `extractor: slack / channel-threads`,
        '---',
        '',
    ];

    const body: string[] = [];
    body.push(`# ${headline || `Thread ${threadTs}`}`);
    body.push('');
    messages.forEach((msg, i) => {
        const user = msg.user || msg.username || msg.bot_id || 'unknown';
        const ts = formatTimestamp(msg.ts);
        const text = (msg.text ?? '').trimEnd();
        // Render `<@Uxxx>` mentions raw — resolving to display names
        // needs a `users.list` cache that the plugin doesn't carry
        // today. Agents grep on `<@` directly.
        const heading = i === 0
            ? `**<@${user}>** · ${ts}`
            : `**<@${user}>** · ${ts}` + (msg.thread_ts && msg.thread_ts !== msg.ts ? ' · reply' : '');
        body.push(heading);
        body.push('');
        if (text) {
            body.push(text);
            body.push('');
        }
    });

    const path = slug.length > 0
        ? `threads/${dateYmd}-${slug}-${threadTs}.md`
        : `threads/${dateYmd}-${threadTs}.md`;

    return {
        path,
        content: frontmatter.join('\n') + body.join('\n'),
        contentType: 'text/markdown',
    };
}

function oneLine(text: string, cap: number): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= cap) return collapsed;
    return collapsed.slice(0, cap - 1).trimEnd() + '…';
}

function slugify(text: string, cap: number): string {
    if (!text) return '';
    const s = text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        // Strip Slack-isms before slugging: `<@U…>` mentions, `<#C…|name>`
        // channel refs, `<http…>` links — they slug to garbage.
        .replace(/<@[a-z0-9]+>/gi, '')
        .replace(/<#[a-z0-9]+(?:\|[^>]+)?>/gi, '')
        .replace(/<https?:\/\/[^>]+>/gi, '')
        .replace(/[^a-z0-9\s-]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    if (s.length <= cap) return s;
    // Cut at a word boundary near the cap when possible.
    const sliced = s.slice(0, cap);
    const lastDash = sliced.lastIndexOf('-');
    return lastDash > cap / 2 ? sliced.slice(0, lastDash) : sliced;
}

function formatDateYmd(ts: string): string {
    const seconds = parseFloat(ts);
    if (!Number.isFinite(seconds)) return 'unknown-date';
    const d = new Date(seconds * 1000);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
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
