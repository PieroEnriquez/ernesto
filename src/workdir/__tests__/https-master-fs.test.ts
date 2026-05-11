import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeHttpsMasterFs } from '../https-master-fs';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function makeResp(opts: {
    status: number;
    body?: Uint8Array;
    etag?: string;
}): Response {
    // Hand-rolled — the standard `Response` constructor refuses null-body
    // statuses like 304 with a body argument, but our adapter never calls
    // `.arrayBuffer()` on a 304 anyway.
    const headers = new Headers();
    if (opts.etag) headers.set('ETag', opts.etag);
    const body = opts.body ?? new Uint8Array(0);
    return {
        status: opts.status,
        headers,
        async arrayBuffer() {
            return body.buffer.slice(
                body.byteOffset,
                body.byteOffset + body.byteLength,
            );
        },
    } as unknown as Response;
}

describe('makeHttpsMasterFs', () => {
    let fetchImpl: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchImpl = vi.fn();
    });

    it('requires baseUrl and token', () => {
        expect(() => makeHttpsMasterFs({ baseUrl: '', token: 't' })).toThrow();
        expect(() => makeHttpsMasterFs({ baseUrl: 'https://x', token: '' })).toThrow();
    });

    it('happy path: 200 returns bytes + caches etag; next call sends If-None-Match and 304 returns cache', async () => {
        const bytes = enc('# hello world\n');
        const etag = 'W/"sha256-abc123"';

        fetchImpl
            .mockResolvedValueOnce(makeResp({ status: 200, body: bytes, etag }))
            .mockResolvedValueOnce(makeResp({ status: 304, etag }));

        const adapter = makeHttpsMasterFs({
            baseUrl: 'https://api.test',
            token: 'secret-bot',
            fetchImpl: fetchImpl as any,
        });

        // First call: 200
        const r1 = await adapter.resolve('workspaces/hr/INDEX.md');
        expect(r1).toEqual({ kind: 'bytes', bytes, etag });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url1, init1] = fetchImpl.mock.calls[0];
        expect(url1).toBe('https://api.test/master-fs/workspaces/hr/INDEX.md');
        expect((init1 as RequestInit).headers).toEqual({
            Authorization: 'Bearer secret-bot',
        });

        // Second call: 304 → cached bytes returned
        const r2 = await adapter.resolve('workspaces/hr/INDEX.md');
        expect(r2.kind).toBe('bytes');
        if (r2.kind === 'bytes') {
            expect(dec(r2.bytes)).toBe('# hello world\n');
            expect(r2.etag).toBe(etag);
        }
        const [, init2] = fetchImpl.mock.calls[1];
        expect((init2 as RequestInit).headers).toEqual({
            Authorization: 'Bearer secret-bot',
            'If-None-Match': etag,
        });
    });

    it('normalizes trailing slash on baseUrl', async () => {
        fetchImpl.mockResolvedValueOnce(
            makeResp({ status: 200, body: enc('ok'), etag: 'W/"x"' }),
        );
        const adapter = makeHttpsMasterFs({
            baseUrl: 'https://api.test/',
            token: 't',
            fetchImpl: fetchImpl as any,
        });
        await adapter.resolve('a/b.md');
        expect(fetchImpl.mock.calls[0][0]).toBe('https://api.test/master-fs/a/b.md');
    });

    it('404 → { kind: "not-found" }', async () => {
        fetchImpl.mockResolvedValueOnce(makeResp({ status: 404 }));
        const adapter = makeHttpsMasterFs({
            baseUrl: 'https://api.test',
            token: 't',
            fetchImpl: fetchImpl as any,
        });
        const r = await adapter.resolve('missing.md');
        expect(r).toEqual({ kind: 'not-found' });
    });

    it('401 throws', async () => {
        fetchImpl.mockResolvedValueOnce(makeResp({ status: 401 }));
        const adapter = makeHttpsMasterFs({
            baseUrl: 'https://api.test',
            token: 'bad-token',
            fetchImpl: fetchImpl as any,
        });
        await expect(adapter.resolve('a.md')).rejects.toThrow(/unauthorized/i);
    });

    it('500 throws with status in message', async () => {
        fetchImpl.mockResolvedValueOnce(makeResp({ status: 500 }));
        const adapter = makeHttpsMasterFs({
            baseUrl: 'https://api.test',
            token: 't',
            fetchImpl: fetchImpl as any,
        });
        await expect(adapter.resolve('a.md')).rejects.toThrow(/500/);
    });

    it('network error throws with clear message', async () => {
        fetchImpl.mockRejectedValueOnce(new Error('econnrefused'));
        const adapter = makeHttpsMasterFs({
            baseUrl: 'https://api.test',
            token: 't',
            fetchImpl: fetchImpl as any,
        });
        await expect(adapter.resolve('a.md')).rejects.toThrow(/network error/i);
    });

    it('304 with no cached entry throws (server lied)', async () => {
        fetchImpl.mockResolvedValueOnce(makeResp({ status: 304 }));
        const adapter = makeHttpsMasterFs({
            baseUrl: 'https://api.test',
            token: 't',
            fetchImpl: fetchImpl as any,
        });
        await expect(adapter.resolve('a.md')).rejects.toThrow(/304/);
    });

    it('rejects path traversal client-side without sending request', async () => {
        const adapter = makeHttpsMasterFs({
            baseUrl: 'https://api.test',
            token: 't',
            fetchImpl: fetchImpl as any,
        });
        await expect(adapter.resolve('../../etc/passwd')).rejects.toThrow(/invalid/i);
        await expect(adapter.resolve('/abs/path.md')).rejects.toThrow(/invalid/i);
        await expect(adapter.resolve('a/./b.md')).rejects.toThrow(/invalid/i);
        await expect(adapter.resolve('a\0b.md')).rejects.toThrow(/invalid/i);
        await expect(adapter.resolve('a\\b.md')).rejects.toThrow(/invalid/i);
        await expect(adapter.resolve('')).rejects.toThrow(/invalid/i);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('caches per-path independently', async () => {
        fetchImpl
            .mockResolvedValueOnce(makeResp({ status: 200, body: enc('A'), etag: 'W/"a"' }))
            .mockResolvedValueOnce(makeResp({ status: 200, body: enc('B'), etag: 'W/"b"' }))
            .mockResolvedValueOnce(makeResp({ status: 304, etag: 'W/"a"' }))
            .mockResolvedValueOnce(makeResp({ status: 304, etag: 'W/"b"' }));

        const adapter = makeHttpsMasterFs({
            baseUrl: 'https://api.test',
            token: 't',
            fetchImpl: fetchImpl as any,
        });
        await adapter.resolve('a.md');
        await adapter.resolve('b.md');

        const ra = await adapter.resolve('a.md');
        const rb = await adapter.resolve('b.md');
        expect(ra.kind === 'bytes' && dec(ra.bytes)).toBe('A');
        expect(rb.kind === 'bytes' && dec(rb.bytes)).toBe('B');

        expect((fetchImpl.mock.calls[2][1] as RequestInit).headers).toMatchObject({
            'If-None-Match': 'W/"a"',
        });
        expect((fetchImpl.mock.calls[3][1] as RequestInit).headers).toMatchObject({
            'If-None-Match': 'W/"b"',
        });
    });
});
