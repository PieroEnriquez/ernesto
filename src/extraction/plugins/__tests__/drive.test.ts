import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { drivePlugin } from '../drive';
import type { ExtractionContext } from '../../define-extraction';

const makeCtx = (): ExtractionContext => ({
    user: { id: 'u1' },
    scopes: new Set(['extraction:drive:read']),
    log: { info: () => {}, warn: () => {}, error: () => {} },
});

interface MockResponseInit {
    status?: number;
    body?: unknown;
    text?: string;
}

const jsonResponse = (init: MockResponseInit): Response => {
    const status = init.status ?? 200;
    const body = init.text !== undefined ? init.text : JSON.stringify(init.body ?? {});
    return new Response(body, {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
};

const textResponse = (text: string, status = 200): Response =>
    new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });

const driveUrl = (path: string) => `https://www.googleapis.com/drive/v3/files${path}`;

beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('drivePlugin', () => {
    it('rejects construction without an access token', () => {
        expect(() => drivePlugin({ accessToken: '' })).toThrow();
    });

    it('exposes the expected source/scope', () => {
        const plugin = drivePlugin({ accessToken: 'a' });
        expect(plugin.source).toBe('drive');
        expect(plugin.scope).toEqual(['extraction:drive:read']);
    });

    it('fetches a doc and exports as markdown', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/files/doc-1?')) {
                return jsonResponse({ body: { id: 'doc-1', name: 'Hello World', mimeType: 'application/vnd.google-apps.document' } });
            }
            if (url.includes('/files/doc-1/export') && url.includes('text%2Fmarkdown')) {
                return textResponse('# Hello\n\nworld');
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'doc:doc-1' }, makeCtx());

        expect(result.entries).toHaveLength(1);
        expect(result.entries[0]).toEqual({
            path: 'docs/hello-world.md',
            content: '# Hello\n\nworld',
            contentType: 'text/markdown',
        });
        // never log tokens
        for (const call of fetchMock.mock.calls) {
            const init = call[1] as RequestInit | undefined;
            const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
            expect(auth).toBe('Bearer tok');
        }
    });

    it('fetches a sheet and exports as CSV', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/files/sheet-1?')) {
                return jsonResponse({ body: { id: 'sheet-1', name: 'My Sheet', mimeType: 'application/vnd.google-apps.spreadsheet' } });
            }
            if (url.includes('/files/sheet-1/export') && url.includes('text%2Fcsv')) {
                return textResponse('a,b\n1,2\n');
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'sheet:sheet-1' }, makeCtx());

        expect(result.entries).toEqual([
            { path: 'sheets/my-sheet.csv', content: 'a,b\n1,2\n', contentType: 'text/csv' },
        ]);
    });

    it('walks a folder recursively, including nested folders', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);

            // list folder root
            if (url.includes(driveUrl('?')) && url.includes("'root-folder'+in+parents") || url.includes("%27root-folder%27+in+parents")) {
                return jsonResponse({
                    body: {
                        files: [
                            { id: 'doc-a', name: 'Doc A', mimeType: 'application/vnd.google-apps.document' },
                            { id: 'nested', name: 'Nested', mimeType: 'application/vnd.google-apps.folder' },
                            { id: 'skip-me', name: 'Image', mimeType: 'image/png' },
                        ],
                    },
                });
            }
            if (url.includes("%27nested%27+in+parents")) {
                return jsonResponse({
                    body: {
                        files: [
                            { id: 'sheet-b', name: 'Sheet B', mimeType: 'application/vnd.google-apps.spreadsheet' },
                        ],
                    },
                });
            }

            // doc-a meta + export
            if (url.includes('/files/doc-a?')) {
                return jsonResponse({ body: { id: 'doc-a', name: 'Doc A', mimeType: 'application/vnd.google-apps.document' } });
            }
            if (url.includes('/files/doc-a/export')) {
                return textResponse('# Doc A');
            }

            // sheet-b meta + export
            if (url.includes('/files/sheet-b?')) {
                return jsonResponse({ body: { id: 'sheet-b', name: 'Sheet B', mimeType: 'application/vnd.google-apps.spreadsheet' } });
            }
            if (url.includes('/files/sheet-b/export')) {
                return textResponse('x,y\n');
            }

            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'folder:root-folder' }, makeCtx());

        const paths = result.entries.map((e) => e.path).sort();
        expect(paths).toEqual(['docs/doc-a.md', 'sheets/sheet-b.csv']);
    });

    it('refreshes the access token on 401 when a refresh token is provided', async () => {
        const plugin = drivePlugin({
            accessToken: 'old',
            refreshToken: 'rt',
            clientId: 'cid',
            clientSecret: 'csec',
        });

        let metaCalls = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url === 'https://oauth2.googleapis.com/token') {
                expect(init?.method).toBe('POST');
                const body = String(init?.body ?? '');
                expect(body).toContain('grant_type=refresh_token');
                expect(body).toContain('refresh_token=rt');
                return jsonResponse({ body: { access_token: 'new', expires_in: 3600 } });
            }
            if (url.includes('/files/doc-1?')) {
                metaCalls += 1;
                const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
                if (metaCalls === 1) {
                    expect(auth).toBe('Bearer old');
                    return jsonResponse({ status: 401, body: { error: 'unauthorized' } });
                }
                expect(auth).toBe('Bearer new');
                return jsonResponse({ body: { id: 'doc-1', name: 'After Refresh', mimeType: 'application/vnd.google-apps.document' } });
            }
            if (url.includes('/files/doc-1/export')) {
                return textResponse('# refreshed');
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'doc:doc-1' }, makeCtx());

        expect(result.entries).toEqual([
            { path: 'docs/after-refresh.md', content: '# refreshed', contentType: 'text/markdown' },
        ]);
        expect(metaCalls).toBe(2);
    });

    it('throws on 401 when no refresh token is provided', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        const fetchMock = vi.fn(async () => jsonResponse({ status: 401, body: { error: 'unauthorized' } }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(
            plugin.fetch({ target: 'doc:doc-1' }, makeCtx()),
        ).rejects.toThrow(/unauthorized/i);
    });

    it('retries with exponential backoff on 429', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        let metaAttempts = 0;
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/files/doc-1?')) {
                metaAttempts += 1;
                if (metaAttempts < 3) {
                    return jsonResponse({ status: 429, body: { error: 'rate' } });
                }
                return jsonResponse({ body: { id: 'doc-1', name: 'Slow Doc', mimeType: 'application/vnd.google-apps.document' } });
            }
            if (url.includes('/files/doc-1/export')) {
                return textResponse('# slow');
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'doc:doc-1' }, makeCtx());

        expect(metaAttempts).toBe(3);
        expect(result.entries[0].path).toBe('docs/slow-doc.md');
    });

    it('returns empty entries on 404', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        const fetchMock = vi.fn(async () => jsonResponse({ status: 404, body: { error: 'not found' } }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'doc:missing' }, makeCtx());
        expect(result.entries).toEqual([]);
        expect(typeof result.fetchedAt).toBe('string');
    });

    it('returns empty entries when a folder 404s', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        const fetchMock = vi.fn(async () => jsonResponse({ status: 404, body: {} }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'folder:gone' }, makeCtx());
        expect(result.entries).toEqual([]);
    });

    it('fetches a PDF as base64 binary via alt=media', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        // Arbitrary binary bytes (not valid PDF — we only check passthrough)
        const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x00, 0xff, 0xfe]);
        const expectedBase64 = Buffer.from(bytes).toString('base64');

        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/files/pdf-1?') && !url.includes('alt=media')) {
                return jsonResponse({ body: { id: 'pdf-1', name: 'Quarterly Report', mimeType: 'application/pdf' } });
            }
            if (url.includes('/files/pdf-1?alt=media')) {
                // ArrayBuffer body
                return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/pdf' } });
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'pdf:pdf-1' }, makeCtx());

        expect(result.entries).toEqual([
            {
                path: 'pdfs/quarterly-report.pdf',
                content: expectedBase64,
                contentType: 'application/pdf',
            },
        ]);
    });

    it('returns empty entries when the PDF target 404s', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        const fetchMock = vi.fn(async () => jsonResponse({ status: 404, body: { error: 'not found' } }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'pdf:missing' }, makeCtx());
        expect(result.entries).toEqual([]);
        expect(typeof result.fetchedAt).toBe('string');
    });

    it('fetches a DOCX exported as markdown via Drive', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes('/files/docx-1?') && !url.includes('export')) {
                return jsonResponse({
                    body: {
                        id: 'docx-1',
                        name: 'Meeting Notes',
                        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                    },
                });
            }
            if (url.includes('/files/docx-1/export') && url.includes('text%2Fmarkdown')) {
                return textResponse('# Meeting Notes\n\n- item 1\n- item 2');
            }
            throw new Error(`unexpected url: ${url}`);
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'docx:docx-1' }, makeCtx());

        expect(result.entries).toEqual([
            {
                path: 'docs/meeting-notes.md',
                content: '# Meeting Notes\n\n- item 1\n- item 2',
                contentType: 'text/markdown',
            },
        ]);
    });

    it('returns empty entries when the DOCX target 404s', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        const fetchMock = vi.fn(async () => jsonResponse({ status: 404, body: { error: 'not found' } }));
        vi.stubGlobal('fetch', fetchMock);

        const result = await plugin.fetch({ target: 'docx:missing' }, makeCtx());
        expect(result.entries).toEqual([]);
    });

    it('rejects invalid target shapes', async () => {
        const plugin = drivePlugin({ accessToken: 'tok' });
        vi.stubGlobal('fetch', vi.fn());
        await expect(plugin.fetch({ target: 'bogus' }, makeCtx())).rejects.toThrow();
        await expect(plugin.fetch({ target: 'video:abc' }, makeCtx())).rejects.toThrow();
    });
});
