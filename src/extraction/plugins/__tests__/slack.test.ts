import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { slackPlugin } from '../slack';
import type { ExtractionContext } from '../../define-extraction';

const TOKEN = 'xoxb-test-12345-supersecret';

const makeCtx = (scopes: Iterable<string> = ['extraction:slack:read']): ExtractionContext => ({
    user: { id: 'u1' },
    scopes: new Set(scopes),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const slackOk = (body: Record<string, unknown>): Response =>
    new Response(JSON.stringify({ ok: true, ...body }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

const slackErr = (error: string): Response =>
    new Response(JSON.stringify({ ok: false, error }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });

const rateLimited = (retryAfter?: string): Response => {
    const headers: Record<string, string> = {};
    if (retryAfter !== undefined) headers['retry-after'] = retryAfter;
    return new Response('rate limited', { status: 429, headers });
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('slackPlugin – metadata', () => {
    it('exposes the documented source, scope, and description', () => {
        const plugin = slackPlugin({ token: TOKEN });
        expect(plugin.source).toBe('slack');
        expect(plugin.scope).toEqual(['extraction:slack:read']);
        expect(plugin.description).toMatch(/Slack/);
    });

    it('throws when constructed without a token', () => {
        expect(() => slackPlugin({ token: '' })).toThrow(/token is required/);
    });
});

describe('slackPlugin – channel target happy path', () => {
    it('fetches conversations.history and renders a markdown entry under channels/{id}.md', async () => {
        const messages = [
            { ts: '1700000200.000100', user: 'U2', text: 'second message' },
            { ts: '1700000100.000200', user: 'U1', text: 'first message' },
        ];
        const fetchMock = vi.fn().mockResolvedValue(slackOk({ messages }));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = slackPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'channel:C12345' },
            makeCtx(),
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toMatch(/^https:\/\/slack\.com\/api\/conversations\.history\?/);
        expect(url).toContain('channel=C12345');
        expect((init as RequestInit).headers).toMatchObject({
            Authorization: `Bearer ${TOKEN}`,
        });

        expect(result.entries).toHaveLength(1);
        const entry = result.entries[0];
        expect(entry.path).toBe('channels/C12345.md');
        expect(entry.contentType).toBe('text/markdown');
        expect(entry.content).toContain('# Channel C12345');
        expect(entry.content).toContain('2 messages');
        // Oldest first (first message should appear before second).
        const firstIdx = entry.content.indexOf('first message');
        const secondIdx = entry.content.indexOf('second message');
        expect(firstIdx).toBeGreaterThan(-1);
        expect(secondIdx).toBeGreaterThan(firstIdx);
        // Token never appears in the rendered output.
        expect(entry.content).not.toContain(TOKEN);
        expect(typeof result.fetchedAt).toBe('string');
    });
});

describe('slackPlugin – thread target happy path', () => {
    it('fetches conversations.replies and renders a markdown entry under threads/{ts}.md', async () => {
        const messages = [
            { ts: '1700000100.000100', user: 'U1', text: 'parent message' },
            { ts: '1700000150.000100', user: 'U2', text: 'reply one', thread_ts: '1700000100.000100' },
            { ts: '1700000200.000100', user: 'U3', text: 'reply two', thread_ts: '1700000100.000100' },
        ];
        const fetchMock = vi.fn().mockResolvedValue(slackOk({ messages }));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = slackPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'thread:C12345:1700000100.000100' },
            makeCtx(),
        );

        const [url] = fetchMock.mock.calls[0];
        expect(url).toMatch(/^https:\/\/slack\.com\/api\/conversations\.replies\?/);
        expect(url).toContain('channel=C12345');
        expect(url).toContain('ts=1700000100.000100');

        expect(result.entries).toHaveLength(1);
        const entry = result.entries[0];
        expect(entry.path).toBe('threads/1700000100.000100.md');
        expect(entry.contentType).toBe('text/markdown');
        expect(entry.content).toContain('# Thread 1700000100.000100');
        expect(entry.content).toContain('parent message');
        expect(entry.content).toContain('reply one');
        expect(entry.content).toContain('reply two');
        // Replies are indented (start with spaces before '- ').
        const replyLine = entry.content.split('\n').find((l) => l.includes('reply one'));
        expect(replyLine).toBeDefined();
        expect(replyLine!.startsWith('    ')).toBe(true);
        // Parent is not indented.
        const parentLine = entry.content.split('\n').find((l) => l.includes('parent message'));
        expect(parentLine!.startsWith('- ')).toBe(true);
    });
});

describe('slackPlugin – invalid_auth (HTTP 200 + ok:false)', () => {
    it('throws with the Slack error string and never logs the token', async () => {
        const fetchMock = vi.fn().mockResolvedValue(slackErr('invalid_auth'));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = slackPlugin({ token: TOKEN });

        await expect(
            plugin.fetch({ target: 'channel:C404' }, ctx),
        ).rejects.toThrow(/invalid_auth/);

        // Token must not appear in any log call.
        const logs = [
            ...(ctx.log.info as ReturnType<typeof vi.fn>).mock.calls,
            ...(ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls,
            ...(ctx.log.error as ReturnType<typeof vi.fn>).mock.calls,
        ];
        for (const call of logs) {
            const serialized = JSON.stringify(call);
            expect(serialized).not.toContain(TOKEN);
        }
    });

    it('throws on non-auth Slack errors too (channel_not_found)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(slackErr('channel_not_found'));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = slackPlugin({ token: TOKEN });
        await expect(
            plugin.fetch({ target: 'channel:Cgone' }, makeCtx()),
        ).rejects.toThrow(/channel_not_found/);
    });
});

describe('slackPlugin – 429 with Retry-After', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('waits Retry-After seconds and retries on 429', async () => {
        const messages = [{ ts: '1700000100.000100', user: 'U1', text: 'hi' }];
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(rateLimited('2'))
            .mockResolvedValueOnce(slackOk({ messages }));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = slackPlugin({ token: TOKEN, backoffBaseMs: 500, maxRetries: 3 });

        const promise = plugin.fetch({ target: 'channel:C1' }, ctx);

        // Let the initial fetch resolve and schedule the retry timer.
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Retry-After: 2 seconds → 2000ms wait.
        await vi.advanceTimersByTimeAsync(2000);
        const result = await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(ctx.log.warn).toHaveBeenCalledWith(
            'Slack rate limited, backing off',
            expect.objectContaining({ attempt: 1, delayMs: 2000, fromHeader: true }),
        );
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].content).toContain('hi');
    });

    it('falls back to exponential backoff when Retry-After is missing', async () => {
        const messages = [{ ts: '1700000100.000100', user: 'U1', text: 'hi' }];
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(rateLimited(undefined))
            .mockResolvedValueOnce(slackOk({ messages }));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = slackPlugin({ token: TOKEN, backoffBaseMs: 500, maxRetries: 3 });

        const promise = plugin.fetch({ target: 'channel:C1' }, ctx);

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Backoff: 500 * 2^0 = 500ms.
        await vi.advanceTimersByTimeAsync(500);
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(ctx.log.warn).toHaveBeenCalledWith(
            'Slack rate limited, backing off',
            expect.objectContaining({ attempt: 1, delayMs: 500, fromHeader: false }),
        );
    });
});

describe('slackPlugin – target parsing', () => {
    it('rejects unsupported target prefixes', async () => {
        const plugin = slackPlugin({ token: TOKEN });
        await expect(
            plugin.fetch({ target: 'message:C1:1700000100.0001' }, makeCtx()),
        ).rejects.toThrow(/unsupported target kind/);
    });

    it('rejects malformed thread targets', async () => {
        const plugin = slackPlugin({ token: TOKEN });
        await expect(
            plugin.fetch({ target: 'thread:C1' }, makeCtx()),
        ).rejects.toThrow(/invalid thread target/);
    });

    it('rejects non-positive-integer days on channel-threads', async () => {
        const plugin = slackPlugin({ token: TOKEN });
        await expect(
            plugin.fetch({ target: 'channel-threads:C1:0' }, makeCtx()),
        ).rejects.toThrow(/positive integer/);
        await expect(
            plugin.fetch({ target: 'channel-threads:C1:-7' }, makeCtx()),
        ).rejects.toThrow(/positive integer/);
        await expect(
            plugin.fetch({ target: 'channel-threads:C1:thirty' }, makeCtx()),
        ).rejects.toThrow(/positive integer/);
    });
});

describe('slackPlugin – channel-threads target', () => {
    // Use real-clock helpers so the oldest= cutoff math is testable.
    const realNowSec = 1_730_000_000; // 2024-10-26ish, fine fixture
    const dayAgoSec = (n: number) => String(realNowSec - n * 24 * 60 * 60);

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(realNowSec * 1000));
    });

    it('walks history, fans out every thread parent, and emits one doc per thread', async () => {
        // Two parents in window, one plain (no replies) message — only
        // the two parents should produce entries.
        const historyPage = [
            // newest first per Slack convention
            { ts: dayAgoSec(1) + '.000200', user: 'U1', text: 'unreplied chatter' },
            { ts: dayAgoSec(2) + '.000100', user: 'U2', text: 'Incident: checkout flow regressed', reply_count: 2, thread_ts: dayAgoSec(2) + '.000100' },
            { ts: dayAgoSec(5) + '.000100', user: 'U3', text: 'Q4 planning kick-off', reply_count: 1, thread_ts: dayAgoSec(5) + '.000100' },
        ];
        const repliesParent1 = [
            { ts: dayAgoSec(2) + '.000100', user: 'U2', text: 'Incident: checkout flow regressed' },
            { ts: dayAgoSec(2) + '.001000', user: 'U4', text: 'looking into it' },
            { ts: dayAgoSec(2) + '.002000', user: 'U2', text: 'rolled back' },
        ];
        const repliesParent2 = [
            { ts: dayAgoSec(5) + '.000100', user: 'U3', text: 'Q4 planning kick-off' },
            { ts: dayAgoSec(5) + '.001000', user: 'U1', text: 'putting docs together' },
        ];

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('conversations.history')) {
                return slackOk({ messages: historyPage, has_more: false });
            }
            if (url.includes(`ts=${dayAgoSec(2)}.000100`)) {
                return slackOk({ messages: repliesParent1 });
            }
            if (url.includes(`ts=${dayAgoSec(5)}.000100`)) {
                return slackOk({ messages: repliesParent2 });
            }
            throw new Error(`unexpected url ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const plugin = slackPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'channel-threads:C12345:30' },
            makeCtx(),
        );

        // Two threads → two entries; the unreplied message is skipped.
        expect(result.entries).toHaveLength(2);

        // History call was made with the right oldest= cutoff.
        const [historyUrl] = fetchMock.mock.calls[0];
        expect(String(historyUrl)).toContain('conversations.history');
        expect(String(historyUrl)).toContain(`oldest=${realNowSec - 30 * 24 * 60 * 60}`);

        // Path shape: threads/{YYYY-MM-DD}-{slug}-{ts}.md
        const paths = result.entries.map((e) => e.path).sort();
        for (const p of paths) {
            expect(p).toMatch(/^threads\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+-\d+\.\d+\.md$/);
        }

        // Frontmatter is present and well-formed.
        const incident = result.entries.find((e) => e.path.includes('incident'));
        expect(incident).toBeDefined();
        expect(incident!.content).toMatch(/^---\n/);
        expect(incident!.content).toContain('source: slack');
        expect(incident!.content).toContain('type: thread');
        expect(incident!.content).toContain('reply_count: 2');
        expect(incident!.content).toContain('channel_id: C12345');
        expect(incident!.content).toContain('participants: [U2, U4]');

        // Body has the headline + each message in posting order.
        expect(incident!.content).toContain('# Incident: checkout flow regressed');
        const idxParent = incident!.content.indexOf('rolled back');
        const idxReply = incident!.content.indexOf('looking into it');
        expect(idxReply).toBeGreaterThan(-1);
        expect(idxReply).toBeLessThan(idxParent);
    });

    it('defaults to 30 days when :{days} is omitted', async () => {
        const fetchMock = vi.fn().mockResolvedValue(slackOk({ messages: [], has_more: false }));
        vi.stubGlobal('fetch', fetchMock);
        const plugin = slackPlugin({ token: TOKEN });
        await plugin.fetch({ target: 'channel-threads:C1' }, makeCtx());
        const [url] = fetchMock.mock.calls[0];
        expect(String(url)).toContain(`oldest=${realNowSec - 30 * 24 * 60 * 60}`);
    });

    it('paginates conversations.history with cursor until has_more=false', async () => {
        const historyPage1 = [
            { ts: dayAgoSec(1) + '.000100', user: 'U1', text: 'Page 1 thread', reply_count: 1, thread_ts: dayAgoSec(1) + '.000100' },
        ];
        const historyPage2 = [
            { ts: dayAgoSec(2) + '.000100', user: 'U2', text: 'Page 2 thread', reply_count: 1, thread_ts: dayAgoSec(2) + '.000100' },
        ];
        let nHistory = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('conversations.history')) {
                nHistory += 1;
                if (nHistory === 1) {
                    return slackOk({
                        messages: historyPage1,
                        has_more: true,
                        response_metadata: { next_cursor: 'cursor-page-2' },
                    });
                }
                expect(url).toContain('cursor=cursor-page-2');
                return slackOk({ messages: historyPage2, has_more: false });
            }
            // Any thread replies call: return a minimal valid thread.
            const m = url.match(/ts=(\d+\.\d+)/);
            const ts = m ? m[1] : '0';
            return slackOk({ messages: [{ ts, user: 'U1', text: 'parent' }, { ts: ts + '1', user: 'U2', text: 'reply' }] });
        });
        vi.stubGlobal('fetch', fetchMock);

        const plugin = slackPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'channel-threads:C1:30' },
            makeCtx(),
        );

        expect(nHistory).toBe(2);
        expect(result.entries).toHaveLength(2);
    });
});
