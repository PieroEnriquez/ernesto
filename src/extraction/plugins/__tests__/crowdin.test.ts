import { describe, it, expect, vi, afterEach } from 'vitest';
import { crowdinPlugin } from '../crowdin';
import type { ExtractionContext } from '../../define-extraction';

const API_KEY = 'crowdin_test_key';

const makeCtx = (): ExtractionContext => ({
    user: { id: 'u1' },
    scopes: new Set(['extraction:crowdin:read']),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

/** Crowdin envelopes every list payload as { data: [{ data: T }, ...] }. */
const envelope = <T>(items: T[]) => ({ data: items.map((d) => ({ data: d })) });

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('crowdinPlugin', () => {
    it('exposes source / scope / description', () => {
        const plugin = crowdinPlugin({ apiKey: API_KEY });
        expect(plugin.source).toBe('crowdin');
        expect(plugin.scope).toEqual(['extraction:crowdin:read']);
        expect(plugin.description).toMatch(/Crowdin/);
    });

    it('rejects construction without an apiKey', () => {
        expect(() => crowdinPlugin({ apiKey: '' })).toThrow(/apiKey/);
    });

    describe('glossaries:project:{id}', () => {
        it('filters glossaries by projectIds + defaultProjectId, fetches terms for each, emits one entry per glossary', async () => {
            const allGlossaries = [
                { id: 11, name: 'EN Terms', projectIds: [100, 200] },
                { id: 22, name: 'FR Terms', defaultProjectId: 100 },
                { id: 33, name: 'Other Project Only', projectIds: [999] }, // not in project 100
            ];
            const termsForGlossary: Record<number, unknown[]> = {
                11: [{ id: 'term-1' }, { id: 'term-2' }],
                22: [{ id: 'term-3' }],
            };

            const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url.includes('/glossaries?')) {
                    return jsonResponse(200, envelope(allGlossaries));
                }
                const m = url.match(/\/glossaries\/(\d+)\/terms\?/);
                if (m) {
                    const gid = parseInt(m[1], 10);
                    return jsonResponse(200, envelope(termsForGlossary[gid] ?? []));
                }
                throw new Error(`unexpected url: ${url}`);
            });
            vi.stubGlobal('fetch', fetchMock);

            const plugin = crowdinPlugin({ apiKey: API_KEY });
            const result = await plugin.fetch({ target: 'glossaries:project:100' }, makeCtx());

            // Only glossaries 11 and 22 belong to project 100.
            const paths = result.entries.map((e) => e.path).sort();
            expect(paths).toEqual(['glossaries/11-en-terms.json', 'glossaries/22-fr-terms.json']);

            // Each entry's content carries both the glossary and its terms.
            const eleven = result.entries.find((e) => e.path.startsWith('glossaries/11-'))!;
            const parsed = JSON.parse(eleven.content) as { glossary: { id: number }; terms: { id: string }[] };
            expect(parsed.glossary.id).toBe(11);
            expect(parsed.terms).toEqual([{ id: 'term-1' }, { id: 'term-2' }]);

            // Bearer header is set on every call.
            for (const [, init] of fetchMock.mock.calls) {
                const headers = (init as RequestInit).headers as Record<string, string>;
                expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
            }
        });

        it('rejects glossaries target without the project sub-target', async () => {
            const plugin = crowdinPlugin({ apiKey: API_KEY });
            vi.stubGlobal('fetch', vi.fn());
            await expect(plugin.fetch({ target: 'glossaries:42' }, makeCtx())).rejects.toThrow(/glossaries:project/);
        });
    });

    describe('styleguides', () => {
        it('lists all styleguides, one entry each', async () => {
            const styleguides = [
                { id: 7, title: 'Brand Voice' },
                { id: 8, name: 'Tone Guide' },
            ];
            const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
                const url = String(input);
                if (url.includes('/style-guides?')) {
                    return jsonResponse(200, envelope(styleguides));
                }
                throw new Error(`unexpected url: ${url}`);
            });
            vi.stubGlobal('fetch', fetchMock);

            const plugin = crowdinPlugin({ apiKey: API_KEY });
            const result = await plugin.fetch({ target: 'styleguides' }, makeCtx());

            expect(result.entries.map((e) => e.path).sort()).toEqual(['styleguides/7-brand-voice.json', 'styleguides/8-tone-guide.json']);
        });

        it('returns empty entries when the styleguides endpoint 404s (plan-gated)', async () => {
            vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(404, { error: 'not available' })));
            const plugin = crowdinPlugin({ apiKey: API_KEY });
            const result = await plugin.fetch({ target: 'styleguides' }, makeCtx());
            expect(result.entries).toEqual([]);
        });
    });

    it('rejects unsupported target kinds', async () => {
        const plugin = crowdinPlugin({ apiKey: API_KEY });
        vi.stubGlobal('fetch', vi.fn());
        await expect(plugin.fetch({ target: 'translations:42' }, makeCtx())).rejects.toThrow(/unsupported target kind/);
    });
});
