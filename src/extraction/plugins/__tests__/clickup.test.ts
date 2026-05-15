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
        // ClickUp's REST API takes the raw token in `Authorization` (no Bearer
        // prefix). See commit 6060e48 — the prefix 401s against both v2 and v3.
        expect((init as RequestInit).headers).toMatchObject({
            Authorization: TOKEN,
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

    it('fetches a doc via v3 page_listing and emits one markdown entry per page', async () => {
        const listing = [
            { id: 'p1', doc_id: 'doc9', workspace_id: 42, name: 'Intro' },
            { id: 'p2', doc_id: 'doc9', workspace_id: 42, name: 'Setup Guide' },
        ];
        const page1 = { id: 'p1', doc_id: 'doc9', name: 'Intro', content: '# Intro\n\nBody.' };
        const page2 = { id: 'p2', doc_id: 'doc9', name: 'Setup Guide', content: '# Setup\n' };

        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, listing))
            .mockResolvedValueOnce(jsonResponse(200, page1))
            .mockResolvedValueOnce(jsonResponse(200, page2));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN, workspaceId: '42' });
        const result = await plugin.fetch(
            { target: 'doc:doc9' },
            makeCtx(),
        );

        expect(fetchMock).toHaveBeenCalledTimes(3);
        const [listingUrl] = fetchMock.mock.calls[0];
        expect(listingUrl).toBe(
            'https://api.clickup.com/api/v3/workspaces/42/docs/doc9/page_listing',
        );
        const [pageUrl1] = fetchMock.mock.calls[1];
        expect(pageUrl1).toBe(
            'https://api.clickup.com/api/v3/workspaces/42/docs/doc9/pages/p1?content_format=text%2Fmd',
        );

        expect(result.entries).toHaveLength(2);
        expect(result.entries[0]).toEqual({
            path: 'docs/doc9/intro.md',
            content: '# Intro\n\nBody.',
            contentType: 'text/markdown',
        });
        expect(result.entries[1]).toEqual({
            path: 'docs/doc9/setup-guide.md',
            content: '# Setup\n',
            contentType: 'text/markdown',
        });
    });

    it('flattens nested doc pages from the page_listing tree', async () => {
        const listing = [
            {
                id: 'root',
                doc_id: 'docX',
                workspace_id: 7,
                name: 'Root',
                pages: [
                    { id: 'child', doc_id: 'docX', workspace_id: 7, name: 'Child' },
                ],
            },
        ];
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, listing))
            .mockResolvedValueOnce(jsonResponse(200, { content: 'root body' }))
            .mockResolvedValueOnce(jsonResponse(200, { content: 'child body' }));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN, workspaceId: '7' });
        const result = await plugin.fetch({ target: 'doc:docX' }, makeCtx());

        expect(result.entries.map((e) => e.path)).toEqual([
            'docs/docX/root.md',
            'docs/docX/child.md',
        ]);
    });

    it('disambiguates slug collisions across pages with -{pageId}', async () => {
        const listing = [
            { id: 'a', doc_id: 'd', workspace_id: 1, name: 'Same Name' },
            { id: 'b', doc_id: 'd', workspace_id: 1, name: 'Same Name' },
        ];
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, listing))
            .mockResolvedValueOnce(jsonResponse(200, { content: 'A' }))
            .mockResolvedValueOnce(jsonResponse(200, { content: 'B' }));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN, workspaceId: '1' });
        const result = await plugin.fetch({ target: 'doc:d' }, makeCtx());

        expect(result.entries.map((e) => e.path)).toEqual([
            'docs/d/same-name-a.md',
            'docs/d/same-name-b.md',
        ]);
    });

    it('throws a clear error when doc target is requested without workspaceId', async () => {
        const plugin = clickupPlugin({ token: TOKEN });
        await expect(
            plugin.fetch({ target: 'doc:doc9' }, makeCtx()),
        ).rejects.toThrow(/workspaceId option required for doc:/);
    });

    it('returns empty entries when the doc page_listing 404s', async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(404));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = clickupPlugin({ token: TOKEN, workspaceId: '42' });
        const result = await plugin.fetch({ target: 'doc:gone' }, ctx);

        expect(result.entries).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(ctx.log.info).toHaveBeenCalledWith(
            'ClickUp target not found',
            expect.objectContaining({ kind: 'doc' }),
        );
    });

    it('skips a single page that 404s but keeps the rest', async () => {
        const listing = [
            { id: 'p1', doc_id: 'd', workspace_id: 1, name: 'One' },
            { id: 'p2', doc_id: 'd', workspace_id: 1, name: 'Two' },
        ];
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(jsonResponse(200, listing))
            .mockResolvedValueOnce(emptyResponse(404))
            .mockResolvedValueOnce(jsonResponse(200, { content: 'two body' }));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = clickupPlugin({ token: TOKEN, workspaceId: '1' });
        const result = await plugin.fetch({ target: 'doc:d' }, ctx);

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].path).toBe('docs/d/two.md');
        expect(ctx.log.warn).toHaveBeenCalledWith(
            'ClickUp doc page not found, skipping',
            expect.objectContaining({ docId: 'd', pageId: 'p1' }),
        );
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
            plugin.fetch({ target: 'video:xyz' }, makeCtx()),
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

describe('clickupPlugin – doc subtree filter', () => {
    it('drops pages outside the rootPageId subtree', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/page_listing')) {
                // Tree shape:
                //   root-A (kept)
                //     child-A1 (kept — parent is root-A)
                //   root-B (dropped — sibling of root-A, target is root-A)
                //     child-B1 (dropped)
                return jsonResponse(200, [
                    { id: 'root-A', name: 'Root A', pages: [
                        { id: 'child-A1', name: 'A1', parent_page_id: 'root-A' },
                    ] },
                    { id: 'root-B', name: 'Root B', pages: [
                        { id: 'child-B1', name: 'B1', parent_page_id: 'root-B' },
                    ] },
                ]);
            }
            // Per-page fetch
            const m = url.match(/\/pages\/([^?]+)/);
            if (m) {
                return jsonResponse(200, { id: m[1], content: `body of ${m[1]}` });
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN, workspaceId: 'ws-1' });
        const result = await plugin.fetch(
            { target: 'doc:doc-1:root-A' },
            makeCtx(),
        );

        const paths = result.entries.map((e) => e.path).sort();
        // Only root-A and child-A1 should produce entries; root-B subtree is filtered out.
        expect(paths).toEqual(['docs/doc-1/a1.md', 'docs/doc-1/root-a.md']);
        // Per-page calls must have been made only for the kept pages.
        const pageCalls = fetchMock.mock.calls.filter(([u]) => String(u).includes('/pages/'));
        const pageIds = pageCalls.map(([u]) => (String(u).match(/\/pages\/([^?]+)/) as RegExpMatchArray)[1]).sort();
        expect(pageIds).toEqual(['child-A1', 'root-A']);
    });

    it('returns empty entries when rootPageId is missing from the listing', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.endsWith('/page_listing')) {
                return jsonResponse(200, [
                    { id: 'root-A', name: 'Root A', pages: [] },
                ]);
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN, workspaceId: 'ws-1' });
        const result = await plugin.fetch(
            { target: 'doc:doc-1:missing-root' },
            makeCtx(),
        );

        expect(result.entries).toEqual([]);
    });
});

describe('clickupPlugin – folder walk', () => {
    it('emits lists + docs under a folder, applying excludePaths', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            // Folder metadata — has two embedded lists, one of which we'll exclude.
            if (/\/folder\/folder-1$/.test(url)) {
                return jsonResponse(200, {
                    id: 'folder-1',
                    name: 'Code Quality',
                    lists: [
                        { id: 'L1', name: 'general', archived: false },
                        { id: 'L2', name: 'agent-ops', archived: false },
                    ],
                });
            }
            // Doc search in folder.
            if (url.includes('/workspaces/ws-1/docs?') && url.includes('parent_id=folder-1')) {
                return jsonResponse(200, { docs: [{ id: 'D1', name: 'Coding Style' }], last_page: true });
            }
            // List fetch (only L1 should be fetched, L2 is filtered out).
            if (/\/list\/L1$/.test(url)) {
                return jsonResponse(200, { id: 'L1', name: 'general' });
            }
            // Doc page listing + per-page fetch.
            if (url.endsWith('/docs/D1/page_listing')) {
                return jsonResponse(200, [{ id: 'P1', name: 'page 1' }]);
            }
            if (url.includes('/docs/D1/pages/P1')) {
                return jsonResponse(200, { id: 'P1', content: '# page 1' });
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN, workspaceId: 'ws-1' });
        const result = await plugin.fetch(
            { target: 'folder:folder-1', excludePaths: ['/list/agent-ops'] },
            makeCtx(),
        );

        const paths = result.entries.map((e) => e.path).sort();
        expect(paths).toEqual(['docs/D1/page-1.md', 'lists/L1.json']);
        // L2 must never have been fetched — its emit was skipped by the filter.
        const calledL2 = fetchMock.mock.calls.some(([u]) => /\/list\/L2$/.test(String(u)));
        expect(calledL2).toBe(false);
    });

    it('respects includePaths (allow-list)', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (/\/folder\/folder-1$/.test(url)) {
                return jsonResponse(200, {
                    id: 'folder-1',
                    name: 'Specs',
                    lists: [
                        { id: 'L1', name: 'draft', archived: false },
                        { id: 'L2', name: 'archived-but-listed', archived: false },
                    ],
                });
            }
            if (url.includes('/workspaces/ws-1/docs?')) {
                return jsonResponse(200, { docs: [], last_page: true });
            }
            if (/\/list\/L1$/.test(url)) {
                return jsonResponse(200, { id: 'L1', name: 'draft' });
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN, workspaceId: 'ws-1' });
        const result = await plugin.fetch(
            { target: 'folder:folder-1', includePaths: ['draft'] },
            makeCtx(),
        );

        const paths = result.entries.map((e) => e.path);
        expect(paths).toEqual(['lists/L1.json']);
    });

    it('requires workspaceId for folder: targets', async () => {
        const plugin = clickupPlugin({ token: TOKEN });
        vi.stubGlobal('fetch', vi.fn());
        await expect(
            plugin.fetch({ target: 'folder:folder-1' }, makeCtx()),
        ).rejects.toThrow(/workspaceId/);
    });
});

describe('clickupPlugin – space walk', () => {
    it('walks folderless lists + folders + space-level docs', async () => {
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);

            // Folderless lists in space.
            if (/\/space\/space-1\/list/.test(url)) {
                return jsonResponse(200, { lists: [{ id: 'FL1', name: 'inbox', archived: false }] });
            }
            // Folders in space.
            if (/\/space\/space-1\/folder/.test(url)) {
                return jsonResponse(200, {
                    folders: [
                        {
                            id: 'F1',
                            name: 'Engineering',
                            hidden: false,
                            archived: false,
                            lists: [{ id: 'L1', name: 'tasks', archived: false }],
                        },
                    ],
                });
            }
            // Folder-scoped docs (folder F1) — none here.
            if (url.includes('parent_id=F1')) {
                return jsonResponse(200, { docs: [], last_page: true });
            }
            // Space-level docs.
            if (url.includes('parent_id=space-1')) {
                return jsonResponse(200, { docs: [{ id: 'D1', name: 'README' }], last_page: true });
            }
            // List metadata fetch.
            if (/\/list\/FL1$/.test(url)) return jsonResponse(200, { id: 'FL1', name: 'inbox' });
            if (/\/list\/L1$/.test(url)) return jsonResponse(200, { id: 'L1', name: 'tasks' });
            // Doc page listing + per-page fetch.
            if (url.endsWith('/docs/D1/page_listing')) return jsonResponse(200, [{ id: 'P1', name: 'home' }]);
            if (url.includes('/docs/D1/pages/P1')) return jsonResponse(200, { id: 'P1', content: '# home' });
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const plugin = clickupPlugin({ token: TOKEN, workspaceId: 'ws-1' });
        const result = await plugin.fetch({ target: 'space:space-1' }, makeCtx());

        const paths = result.entries.map((e) => e.path).sort();
        expect(paths).toEqual([
            'docs/D1/home.md',
            'lists/FL1.json',
            'lists/L1.json',
        ]);
    });
});
