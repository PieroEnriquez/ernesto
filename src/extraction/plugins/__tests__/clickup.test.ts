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
            { target: 'task:abc123' },
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
            { target: 'list:list_42' },
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
            { target: 'doc:doc9' },
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
            plugin.fetch({ target: 'task:abc' }, makeCtx()),
        ).rejects.toThrow(/auth rejected.*401/);
    });

    it('returns empty entries on 404 (target absent is not fatal)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(404));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = clickupPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'task:gone' },
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
            plugin.fetch({ target: 'space:xyz' }, makeCtx()),
        ).rejects.toThrow(/unsupported target kind/);
    });
});

describe('clickupPlugin – list-table target', () => {
    const listMeta = { id: 'list_99', name: 'Sprint 2026-Q2' };

    const recentTs = () => String(Date.now() - 24 * 60 * 60 * 1000); // 1 day ago
    const ancientTs = () => {
        // 6 months ago — comfortably beyond the 3-month closed-task cutoff.
        const d = new Date();
        d.setMonth(d.getMonth() - 6);
        return String(d.getTime());
    };

    it('renders a markdown table under lists/{id}.md with the legacy columns', async () => {
        const tasks = [
            {
                id: 't1',
                custom_id: 'CUS-1',
                name: 'Open work',
                status: { status: 'in progress', type: 'custom' },
                assignees: [{ username: 'alice' }, { username: 'bob' }],
                tags: [{ name: 'urgent' }],
                priority: { priority: 'high' },
                date_created: '1700000000000',
                date_updated: recentTs(),
                url: 'https://app.clickup.com/t/t1',
            },
            {
                id: 't2',
                custom_id: null,
                name: 'Recently closed',
                status: { status: 'done', type: 'closed' },
                assignees: [],
                tags: [],
                priority: null,
                date_created: '1700000000000',
                date_updated: recentTs(),
                date_closed: recentTs(),
                url: 'https://app.clickup.com/t/t2',
            },
            {
                id: 't3',
                custom_id: null,
                name: 'Old closed (should be excluded)',
                status: { status: 'done', type: 'closed' },
                assignees: [],
                tags: [],
                priority: null,
                date_created: '1500000000000',
                date_updated: ancientTs(),
                date_closed: ancientTs(),
                url: 'https://app.clickup.com/t/t3',
            },
        ];

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, listMeta))
            .mockResolvedValueOnce(jsonResponse(200, { tasks }));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'list-table:list_99' },
            makeCtx(),
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [listUrl] = fetchMock.mock.calls[0];
        const [tasksUrl] = fetchMock.mock.calls[1];
        expect(listUrl).toBe('https://api.clickup.com/api/v2/list/list_99');
        expect(tasksUrl).toBe(
            'https://api.clickup.com/api/v2/list/list_99/task?subtasks=true&include_closed=true',
        );

        expect(result.entries).toHaveLength(1);
        const entry = result.entries[0];
        expect(entry.path).toBe('lists/list_99.md');
        expect(entry.contentType).toBe('text/markdown');
        // Header carries the list name.
        expect(entry.content).toContain('# Sprint 2026-Q2');
        // Column header row.
        expect(entry.content).toContain(
            '| ID | Name | Status | Assignees | Priority | Tags | Updated | URL |',
        );
        // Recent open + recent closed tasks rendered; old closed task excluded.
        expect(entry.content).toContain('CUS-1');
        expect(entry.content).toContain('Open work');
        expect(entry.content).toContain('Recently closed');
        expect(entry.content).not.toContain('Old closed');
    });

    it('returns an empty-list markdown body when the list has no tasks', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, listMeta))
            .mockResolvedValueOnce(jsonResponse(200, { tasks: [] }));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'list-table:list_99' },
            makeCtx(),
        );

        expect(result.entries).toHaveLength(1);
        const entry = result.entries[0];
        expect(entry.path).toBe('lists/list_99.md');
        expect(entry.content).toContain('# Sprint 2026-Q2');
        expect(entry.content).toContain('_No tasks._');
        // No table header rendered for an empty list.
        expect(entry.content).not.toContain('| ID | Name | Status |');
    });

    it('returns empty entries when the list itself is 404', async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(404));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = clickupPlugin({ token: TOKEN });
        const result = await plugin.fetch(
            { target: 'list-table:gone' },
            ctx,
        );

        expect(result.entries).toEqual([]);
        // We bail after the list-meta call — no follow-up for tasks.
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(ctx.log.info).toHaveBeenCalledWith(
            'ClickUp target not found',
            expect.objectContaining({ kind: 'list-table' }),
        );
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

        const promise = plugin.fetch({ target: 'task:abc' }, ctx);

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

        const promise = plugin.fetch({ target: 'task:abc' }, ctx);

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
