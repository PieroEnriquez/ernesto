import { describe, it, expect, vi, afterEach } from 'vitest';
import { devinPlugin } from '../devin';
import type { ExtractionContext } from '../../define-extraction';

const API_KEY = 'devin_test_key';
const ORG_ID = 'org-1';

const makeCtx = (): ExtractionContext => ({
    user: { id: 'u1' },
    scopes: new Set(['extraction:devin:read']),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('devinPlugin', () => {
    it('exposes source / scope / description', () => {
        const plugin = devinPlugin({ apiKey: API_KEY, orgId: ORG_ID });
        expect(plugin.source).toBe('devin');
        expect(plugin.scope).toEqual(['extraction:devin:read']);
        expect(plugin.description).toMatch(/playbooks/);
    });

    it('rejects construction without apiKey or orgId', () => {
        expect(() => devinPlugin({ apiKey: '', orgId: ORG_ID })).toThrow(/apiKey/);
        expect(() => devinPlugin({ apiKey: API_KEY, orgId: '' })).toThrow(/orgId/);
    });

    it('fetches a single playbook and emits playbooks/{id}.json', async () => {
        const playbook = { playbook_id: 'pb-1', title: 'Deploy', updated_at: '2026-05-01' };
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, playbook));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = devinPlugin({ apiKey: API_KEY, orgId: ORG_ID });
        const result = await plugin.fetch({ target: 'playbook:pb-1' }, makeCtx());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(String(url)).toBe(`https://api.devin.ai/v3/organizations/${ORG_ID}/playbooks/pb-1`);
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].path).toBe('playbooks/pb-1.json');
        expect(result.entries[0].contentType).toBe('application/json');
        expect(JSON.parse(result.entries[0].content)).toEqual(playbook);
    });

    it('returns empty entries for missing single playbook (404)', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'nope' })));

        const plugin = devinPlugin({ apiKey: API_KEY, orgId: ORG_ID });
        const result = await plugin.fetch({ target: 'playbook:missing' }, makeCtx());
        expect(result.entries).toEqual([]);
    });

    it('paginates the playbooks listing across multiple pages', async () => {
        const page1 = {
            items: [{ playbook_id: 'pb-1' }, { playbook_id: 'pb-2' }],
            has_next_page: true,
            end_cursor: 'cursor-after-pb-2',
        };
        const page2 = {
            items: [{ playbook_id: 'pb-3' }],
            has_next_page: false,
            end_cursor: null,
        };
        const fetchMock = vi
            .fn()
            .mockImplementationOnce(async () => jsonResponse(200, page1))
            .mockImplementationOnce(async () => jsonResponse(200, page2));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = devinPlugin({ apiKey: API_KEY, orgId: ORG_ID });
        const result = await plugin.fetch({ target: 'playbooks' }, makeCtx());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const [secondCallUrl] = fetchMock.mock.calls[1];
        expect(String(secondCallUrl)).toContain('after=cursor-after-pb-2');

        const ids = result.entries.map((e) => e.path);
        expect(ids).toEqual(['playbooks/pb-1.json', 'playbooks/pb-2.json', 'playbooks/pb-3.json']);
    });

    it('rejects malformed targets', async () => {
        const plugin = devinPlugin({ apiKey: API_KEY, orgId: ORG_ID });
        vi.stubGlobal('fetch', vi.fn());
        await expect(plugin.fetch({ target: 'something-else' }, makeCtx())).rejects.toThrow();
        await expect(plugin.fetch({ target: 'session:abc' }, makeCtx())).rejects.toThrow(/unsupported target kind/);
        await expect(plugin.fetch({ target: 'playbook:' }, makeCtx())).rejects.toThrow();
    });

    it('throws on 401 with a clear message', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(401, { error: 'denied' })));
        const plugin = devinPlugin({ apiKey: API_KEY, orgId: ORG_ID });
        await expect(plugin.fetch({ target: 'playbook:pb-1' }, makeCtx())).rejects.toThrow(/auth rejected/);
    });
});
