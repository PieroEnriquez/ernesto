import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clickupPlugin } from '../clickup';
import type { ExtractionContext } from '../../define-extraction';

const TOKEN = 'pk_test_token_value';

const makeCtx = (scopes: Iterable<string> = ['extraction:clickup:read']): ExtractionContext => ({
    user: { id: 'u1' },
    scopes: new Set(scopes),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });

const emptyResponse = (status: number): Response => new Response(null, { status });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('clickupPlugin – metadata', () => {
    it('exposes the documented source, scope, and description', () => {
        const plugin = clickupPlugin({ token: TOKEN });
        expect(plugin.source).toBe('clickup');
        expect(plugin.scope).toEqual(['extraction:clickup:read']);
        expect(plugin.description).toMatch(/ClickUp/);
    });

    it('throws when constructed without a token', () => {
        expect(() => clickupPlugin({ token: '' })).toThrow(/token is required/);
    });
});

describe('clickupPlugin – happy path per target kind', () => {
    it('fetches a task and returns a JSON entry under tasks/{id}.json', async () => {
        const taskPayload = { id: 'abc123', name: 'Fix login', status: { status: 'open' } };
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, taskPayload));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'task:abc123', format: 'json' },
            makeCtx(),
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.clickup.com/api/v2/task/abc123');
        expect((init as RequestInit).headers).toMatchObject({
            Authorization: `Bearer ${TOKEN}`,
        });

        expect(result.entries).toHaveLength(1);
        const entry = result.entries[0];
        expect(entry.path).toBe('tasks/abc123.json');
        expect(entry.contentType).toBe('application/json');
        expect(JSON.parse(entry.content)).toEqual(taskPayload);
        expect(typeof result.fetchedAt).toBe('string');
    });

    it('fetches a list and returns a JSON entry under lists/{id}.json', async () => {
        const listPayload = { id: 'list_42', name: 'Backlog' };
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, listPayload));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'list:list_42', format: 'json' },
            makeCtx(),
        );

        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.clickup.com/api/v2/list/list_42');
        expect(result.entries[0]).toMatchObject({
            path: 'lists/list_42.json',
            contentType: 'application/json',
        });
        expect(JSON.parse(result.entries[0].content)).toEqual(listPayload);
    });

    it('fetches a doc and returns a markdown entry under docs/{id}.md', async () => {
        const docPayload = { id: 'doc9', name: 'Spec', content: '# Title\n\nBody.' };
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, docPayload));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'doc:doc9', format: 'markdown' },
            makeCtx(),
        );

        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.clickup.com/api/v2/doc/doc9');
        expect(result.entries[0]).toEqual({
            path: 'docs/doc9.md',
            content: '# Title\n\nBody.',
            contentType: 'text/markdown',
        });
    });
});

describe('clickupPlugin – error paths', () => {
    it('throws a clear error on 401 (dispatcher will wrap as fetch_failed)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(401));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN });
        await expect(
            plugin.fetch({ target: 'task:abc', format: 'json' }, makeCtx()),
        ).rejects.toThrow(/auth rejected.*401/);
    });

    it('returns empty entries on 404 (target absent is not fatal)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(404));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = clickupPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'task:gone', format: 'json' },
            ctx,
        );

        expect(result.entries).toEqual([]);
        expect(typeof result.fetchedAt).toBe('string');
        expect(ctx.log.info).toHaveBeenCalledWith(
            'ClickUp target not found',
            expect.objectContaining({ kind: 'task' }),
        );
    });

    it('rejects unsupported target prefixes', async () => {
        const plugin = clickupPlugin({ token: TOKEN });
        await expect(
            plugin.fetch({ target: 'space:xyz', format: 'json' }, makeCtx()),
        ).rejects.toThrow(/unsupported target kind/);
    });
});

describe('clickupPlugin – 429 retry behaviour', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('retries once on 429 with exponential backoff then resolves', async () => {
        const taskPayload = { id: 'abc', name: 'rate-limited then ok' };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(emptyResponse(429))
            .mockResolvedValueOnce(jsonResponse(200, taskPayload));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = clickupPlugin({
            token: TOKEN,
            backoffBaseMs: 500,
            maxRetries: 3,
        });

        const promise = plugin.fetch({ target: 'task:abc', format: 'json' }, ctx);

        // Let the initial fetch resolve and schedule the backoff timer.
        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // First retry backoff = base * 2^0 = 500ms.
        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(ctx.log.warn).toHaveBeenCalledWith(
            'ClickUp rate limited, backing off',
            expect.objectContaining({ attempt: 1, delayMs: 500 }),
        );
        expect(result.entries).toHaveLength(1);
        expect(JSON.parse(result.entries[0].content)).toEqual(taskPayload);
    });

    it('uses exponential backoff across multiple 429s (500, 1000)', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(emptyResponse(429))
            .mockResolvedValueOnce(emptyResponse(429))
            .mockResolvedValueOnce(jsonResponse(200, { id: 'abc' }));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = clickupPlugin({
            token: TOKEN,
            backoffBaseMs: 500,
            maxRetries: 3,
        });

        const promise = plugin.fetch({ target: 'task:abc', format: 'json' }, ctx);

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // First backoff: 500ms (2^0).
        await vi.advanceTimersByTimeAsync(500);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Second backoff: 1000ms (2^1).
        await vi.advanceTimersByTimeAsync(1000);
        await promise;

        expect(fetchMock).toHaveBeenCalledTimes(3);
        const delays = (ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls.map(
            (c) => (c[1] as { delayMs: number }).delayMs,
        );
        expect(delays).toEqual([500, 1000]);
    });
});
