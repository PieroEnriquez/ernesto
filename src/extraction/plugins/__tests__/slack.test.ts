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
            { target: 'channel:C12345', format: 'markdown' },
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
            { target: 'thread:C12345:1700000100.000100', format: 'markdown' },
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
            plugin.fetch({ target: 'channel:C404', format: 'markdown' }, ctx),
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
            plugin.fetch({ target: 'channel:Cgone', format: 'markdown' }, makeCtx()),
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

        const promise = plugin.fetch({ target: 'channel:C1', format: 'markdown' }, ctx);

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

        const promise = plugin.fetch({ target: 'channel:C1', format: 'markdown' }, ctx);

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
            plugin.fetch({ target: 'message:C1:1700000100.0001', format: 'markdown' }, makeCtx()),
        ).rejects.toThrow(/unsupported target kind/);
    });

    it('rejects malformed thread targets', async () => {
        const plugin = slackPlugin({ token: TOKEN });
        await expect(
            plugin.fetch({ target: 'thread:C1', format: 'markdown' }, makeCtx()),
        ).rejects.toThrow(/invalid thread target/);
    });
});
