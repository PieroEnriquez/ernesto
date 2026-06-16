import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { qasePlugin } from '../qase';
import type { ExtractionContext } from '../../define-extraction';

const TOKEN = 'qase_secret_token_value';

const makeCtx = (scopes: Iterable<string> = ['extraction:qase:read']): ExtractionContext => ({
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

// Qase wraps successful responses in `{ status: true, result: <payload> }`.
const qaseOk = (result: unknown): Response => jsonResponse(200, { status: true, result });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('qasePlugin – metadata', () => {
    it('exposes the documented source, scope, and description', () => {
        const plugin = qasePlugin({ token: TOKEN });
        expect(plugin.source).toBe('qase');
        expect(plugin.scope).toEqual(['extraction:qase:read']);
        expect(plugin.description).toMatch(/Qase/);
    });

    it('throws when constructed without a token', () => {
        expect(() => qasePlugin({ token: '' })).toThrow(/token is required/);
    });
});

describe('qasePlugin – auth header shape', () => {
    it('sends the Qase-specific `Token` header (not Authorization: Bearer)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(qaseOk({ id: 1, title: 'Login' }));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = qasePlugin({ token: TOKEN });
        await plugin.fetch({ target: 'case:DEMO:1' }, makeCtx());

        const [, init] = fetchMock.mock.calls[0];
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers.Token).toBe(TOKEN);
        // Qase doesn't use Authorization; explicitly verify we didn't slip into Bearer.
        expect(headers.Authorization).toBeUndefined();
    });
});

describe('qasePlugin – happy path per target kind', () => {
    it('fetches a single case and returns a JSON entry under cases/{id}.json', async () => {
        const casePayload = { id: 42, title: 'Login works' };
        const fetchMock = vi.fn().mockResolvedValue(qaseOk(casePayload));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = qasePlugin({ token: TOKEN });
        const result = await plugin.fetch({ target: 'case:DEMO:42' }, makeCtx());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.qase.io/v1/case/DEMO/42');

        expect(result.entries).toHaveLength(1);
        const entry = result.entries[0];
        expect(entry.path).toBe('cases/42.json');
        expect(entry.contentType).toBe('application/json');
        expect(JSON.parse(entry.content)).toEqual(casePayload);
        expect(typeof result.fetchedAt).toBe('string');
    });

    it('fetches a project and returns a suites listing entry', async () => {
        const suitesPayload = {
            total: 2,
            filtered: 2,
            count: 2,
            entities: [
                { id: 1, title: 'Auth' },
                { id: 2, title: 'Checkout' },
            ],
        };
        const fetchMock = vi.fn().mockResolvedValue(qaseOk(suitesPayload));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = qasePlugin({ token: TOKEN });
        const result = await plugin.fetch({ target: 'project:DEMO' }, makeCtx());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.qase.io/v1/suite/DEMO');

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toMatchObject({
            path: 'projects/DEMO/suites.json',
            contentType: 'application/json',
        });
        expect(JSON.parse(result.entries[0].content)).toEqual(suitesPayload);
    });

    it('fetches a suite + every case in that suite (single page)', async () => {
        const suitePayload = { id: 7, title: 'Auth', cases_count: 2 };
        const casesPage = {
            total: 2,
            filtered: 2,
            count: 2,
            entities: [
                { id: 100, title: 'Login OK', suite_id: 7 },
                { id: 101, title: 'Login bad password', suite_id: 7 },
            ],
        };
        const fetchMock = vi
            .fn()
            // suite metadata
            .mockResolvedValueOnce(qaseOk(suitePayload))
            // cases listing (single page)
            .mockResolvedValueOnce(qaseOk(casesPage));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = qasePlugin({ token: TOKEN });
        const result = await plugin.fetch({ target: 'suite:DEMO:7' }, makeCtx());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const urls = fetchMock.mock.calls.map((c) => c[0] as string);
        expect(urls[0]).toBe('https://api.qase.io/v1/suite/DEMO/7');
        expect(urls[1]).toMatch(/^https:\/\/api\.qase\.io\/v1\/case\/DEMO\?/);
        expect(urls[1]).toContain('suite_id=7');
        expect(urls[1]).toContain('limit=100');
        expect(urls[1]).toContain('offset=0');

        // suite entry + two case entries
        expect(result.entries).toHaveLength(3);
        expect(result.entries[0]).toMatchObject({
            path: 'suites/7.json',
            contentType: 'application/json',
        });
        expect(JSON.parse(result.entries[0].content)).toEqual(suitePayload);
        expect(result.entries[1].path).toBe('cases/7/100.json');
        expect(result.entries[2].path).toBe('cases/7/101.json');
        expect(JSON.parse(result.entries[1].content)).toEqual(casesPage.entities[0]);
    });

    it('paginates the cases listing when filtered > pageSize', async () => {
        const suitePayload = { id: 7, title: 'Auth' };
        const page1 = {
            total: 3,
            filtered: 3,
            count: 2,
            entities: [
                { id: 1, title: 'a' },
                { id: 2, title: 'b' },
            ],
        };
        const page2 = {
            total: 3,
            filtered: 3,
            count: 1,
            entities: [{ id: 3, title: 'c' }],
        };
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(qaseOk(suitePayload))
            .mockResolvedValueOnce(qaseOk(page1))
            .mockResolvedValueOnce(qaseOk(page2));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = qasePlugin({ token: TOKEN, pageSize: 2 });
        const result = await plugin.fetch({ target: 'suite:DEMO:7' }, makeCtx());

        expect(fetchMock).toHaveBeenCalledTimes(3);
        const urls = fetchMock.mock.calls.map((c) => c[0] as string);
        expect(urls[1]).toContain('offset=0');
        expect(urls[1]).toContain('limit=2');
        expect(urls[2]).toContain('offset=2');

        // 1 suite + 3 cases
        expect(result.entries).toHaveLength(4);
        expect(result.entries.slice(1).map((e) => e.path)).toEqual(['cases/7/1.json', 'cases/7/2.json', 'cases/7/3.json']);
    });
});

describe('qasePlugin – error paths', () => {
    it('throws a clear error on 401 (dispatcher will wrap as fetch_failed)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(401));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = qasePlugin({ token: TOKEN });
        await expect(plugin.fetch({ target: 'case:DEMO:1' }, makeCtx())).rejects.toThrow(/auth rejected.*401/);
    });

    it('returns empty entries on 404 (target absent is not fatal)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(404));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = qasePlugin({ token: TOKEN });
        const result = await plugin.fetch({ target: 'case:DEMO:gone' }, ctx);

        expect(result.entries).toEqual([]);
        expect(typeof result.fetchedAt).toBe('string');
        expect(ctx.log.info).toHaveBeenCalledWith('Qase target not found', expect.objectContaining({ kind: 'case' }));
    });

    it('rejects unsupported target prefixes', async () => {
        const plugin = qasePlugin({ token: TOKEN });
        await expect(plugin.fetch({ target: 'milestone:DEMO:1' }, makeCtx())).rejects.toThrow(/unsupported target kind/);
    });

    it('rejects malformed suite/case targets (missing id segment)', async () => {
        const plugin = qasePlugin({ token: TOKEN });
        await expect(plugin.fetch({ target: 'suite:DEMO' }, makeCtx())).rejects.toThrow(/suite target must be/);
    });
});

describe('qasePlugin – 429 retry behaviour', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('retries on 429 with exponential backoff then resolves', async () => {
        const casePayload = { id: 9, title: 'rate-limited then ok' };
        const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(429)).mockResolvedValueOnce(qaseOk(casePayload));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = qasePlugin({
            token: TOKEN,
            backoffBaseMs: 500,
            maxRetries: 3,
        });

        const promise = plugin.fetch({ target: 'case:DEMO:9' }, ctx);

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // First retry backoff = base * 2^0 = 500ms.
        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(ctx.log.warn).toHaveBeenCalledWith('Qase rate limited, backing off', expect.objectContaining({ attempt: 1, delayMs: 500 }));
        expect(result.entries).toHaveLength(1);
        expect(JSON.parse(result.entries[0].content)).toEqual(casePayload);
    });
});

describe('qasePlugin – token redaction', () => {
    it('never logs the token in info/warn/error calls', async () => {
        const fetchMock = vi.fn().mockResolvedValueOnce(emptyResponse(429)).mockResolvedValueOnce(emptyResponse(404));
        vi.stubGlobal('fetch', fetchMock);
        vi.useFakeTimers();

        const ctx = makeCtx();
        const plugin = qasePlugin({
            token: TOKEN,
            backoffBaseMs: 1,
            maxRetries: 3,
        });

        const promise = plugin.fetch({ target: 'case:DEMO:1' }, ctx);
        await vi.advanceTimersByTimeAsync(1);
        await promise;

        const allLogCalls = [
            ...(ctx.log.info as ReturnType<typeof vi.fn>).mock.calls,
            ...(ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls,
            ...(ctx.log.error as ReturnType<typeof vi.fn>).mock.calls,
        ];
        const serialised = JSON.stringify(allLogCalls);
        expect(serialised).not.toContain(TOKEN);
    });
});
