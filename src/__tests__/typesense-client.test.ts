import { vi } from 'vitest';
import {
    indexMcpResources,
    clearAllResources,
    searchMcpResources,
    getMcpResourceStats,
    getSourceFreshness,
    deleteSourceDocuments,
    getDocumentByUri,
    exportSourceDocuments,
} from '../typesense/client';
import { MCP_RESOURCES_COLLECTION } from '../typesense/schema';

/**
 * Create a chainable mock Typesense client
 */
function createMockClient(overrides: Record<string, any> = {}) {
    const mockSearch = vi.fn().mockResolvedValue({ hits: [], found: 0 });
    const mockImport = vi.fn().mockResolvedValue([]);
    const mockDelete = vi.fn().mockResolvedValue({ num_deleted: 0 });
    const mockRetrieveDoc = vi.fn().mockResolvedValue({});
    const mockRetrieveCollection = vi.fn().mockResolvedValue({});
    const mockCreateCollection = vi.fn().mockResolvedValue({});
    const mockDeleteCollection = vi.fn().mockResolvedValue({});

    const documents = vi.fn((docId?: string) => {
        if (docId) {
            return { retrieve: mockRetrieveDoc };
        }
        return {
            search: mockSearch,
            import: mockImport,
            delete: mockDelete,
        };
    });

    const collections = vi.fn((_name?: string) => ({
        retrieve: mockRetrieveCollection,
        delete: mockDeleteCollection,
        documents,
    }));

    // Also handle collections().create()
    (collections as any).create = mockCreateCollection;
    const collectionsNoArg = vi.fn(() => ({ create: mockCreateCollection }));

    // Smart collections mock: with arg returns collection, without returns creator
    const smartCollections = vi.fn((name?: string) => {
        if (name) {
            return {
                retrieve: mockRetrieveCollection,
                delete: mockDeleteCollection,
                documents,
            };
        }
        return { create: mockCreateCollection };
    });

    return {
        client: { collections: smartCollections } as any,
        mocks: {
            search: mockSearch,
            import: mockImport,
            delete: mockDelete,
            retrieveDoc: mockRetrieveDoc,
            retrieveCollection: mockRetrieveCollection,
            createCollection: mockCreateCollection,
            deleteCollection: mockDeleteCollection,
            documents,
            collections: smartCollections,
        },
        ...overrides,
    };
}

function createMockErnesto(clientOverrides: Record<string, any> = {}) {
    const { client, mocks } = createMockClient(clientOverrides);
    return {
        ernesto: { typesense: client } as any,
        mocks,
    };
}

describe('indexMcpResources', () => {
    it('returns zero counts for empty documents array', async () => {
        const { ernesto } = createMockErnesto();
        const result = await indexMcpResources(ernesto, []);
        expect(result).toEqual({ success: 0, failed: 0 });
    });

    it('indexes documents via upsert', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.import.mockResolvedValue([{ success: true }, { success: true }]);

        const docs = [
            { id: '1', uri: 'test://1', domain: 'test', name: 'Doc 1', content: 'c1', description: 'd1', content_size: 2, quality_score: 50, indexed_at: Date.now(), is_unrestricted: true, scopes: [] },
            { id: '2', uri: 'test://2', domain: 'test', name: 'Doc 2', content: 'c2', description: 'd2', content_size: 2, quality_score: 50, indexed_at: Date.now(), is_unrestricted: true, scopes: [] },
        ];

        const result = await indexMcpResources(ernesto, docs as any);
        expect(result.success).toBe(2);
        expect(result.failed).toBe(0);
    });

    it('reports partial failures', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.import.mockResolvedValue([{ success: true }, { success: false, error: 'bad doc' }]);

        const docs = [
            { id: '1', uri: 'test://1', domain: 'test', name: 'Doc 1', content: 'c1', description: 'd1', content_size: 2, quality_score: 50, indexed_at: Date.now(), is_unrestricted: true, scopes: [] },
            { id: '2', uri: 'test://2', domain: 'test', name: 'Doc 2', content: 'bad', description: 'd2', content_size: 3, quality_score: 50, indexed_at: Date.now(), is_unrestricted: true, scopes: [] },
        ];

        const result = await indexMcpResources(ernesto, docs as any);
        expect(result.success).toBe(1);
        expect(result.failed).toBe(1);
    });

    it('returns all failed on import error', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.import.mockRejectedValue(new Error('connection failed'));

        const docs = [{ id: '1', uri: 'test://1', domain: 'test', name: 'Doc', content: 'c', description: 'd', content_size: 1, quality_score: 50, indexed_at: Date.now(), is_unrestricted: true, scopes: [] }];

        const result = await indexMcpResources(ernesto, docs as any);
        expect(result).toEqual({ success: 0, failed: 1 });
    });

    it('creates collection on 404', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.retrieveCollection.mockRejectedValue({ httpStatus: 404 });
        mocks.import.mockResolvedValue([{ success: true }]);

        const docs = [{ id: '1', uri: 'test://1', domain: 'test', name: 'Doc', content: 'c', description: 'd', content_size: 1, quality_score: 50, indexed_at: Date.now(), is_unrestricted: true, scopes: [] }];

        await indexMcpResources(ernesto, docs as any);
        expect(mocks.createCollection).toHaveBeenCalled();
    });
});

describe('clearAllResources', () => {
    it('deletes and recreates the collection', async () => {
        const { ernesto, mocks } = createMockErnesto();

        await clearAllResources(ernesto);

        expect(mocks.deleteCollection).toHaveBeenCalled();
        expect(mocks.createCollection).toHaveBeenCalled();
    });

    it('handles 404 gracefully (collection does not exist)', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.deleteCollection.mockRejectedValue({ httpStatus: 404 });

        // Should not throw
        await clearAllResources(ernesto);
    });

    it('throws on non-404 errors', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.deleteCollection.mockRejectedValue({ httpStatus: 500, message: 'Server error' });

        await expect(clearAllResources(ernesto)).rejects.toEqual({ httpStatus: 500, message: 'Server error' });
    });
});

describe('searchMcpResources', () => {
    it('returns empty array when no hits', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({ hits: [], found: 0 });

        const results = await searchMcpResources(ernesto, 'test query');
        expect(results).toEqual([]);
    });

    it('returns mapped search results', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({
            hits: [{
                document: {
                    uri: 'code://prs/123',
                    domain: 'code',
                    name: 'Fix bug',
                    description: 'Fixed auth bug',
                    content_size: 100,
                    child_count: 0,
                    scopes: [],
                },
                text_match_info: { score: 42 },
                highlights: [
                    { field: 'description', snippet: 'Fixed <mark>auth</mark> bug' },
                ],
            }],
            found: 1,
        });

        const results = await searchMcpResources(ernesto, 'auth bug');
        expect(results).toHaveLength(1);
        expect(results[0].uri).toBe('code://prs/123');
        expect(results[0].domain).toBe('code');
        expect(results[0].descriptionSnippet).toContain('auth');
    });

    it('filters by domain when specified', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({ hits: [], found: 0 });

        await searchMcpResources(ernesto, 'test', { domain: 'redshift' });

        const searchParams = mocks.search.mock.calls[0][0];
        expect(searchParams.filter_by).toContain('domain:=redshift');
    });

    it('applies scope-based pre-filtering for users with scopes', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({ hits: [], found: 0 });

        await searchMcpResources(ernesto, 'test', { scopes: ['admin', 'read'] });

        const searchParams = mocks.search.mock.calls[0][0];
        expect(searchParams.filter_by).toContain('is_unrestricted:true');
        expect(searchParams.filter_by).toContain('scopes');
    });

    it('only shows unrestricted docs for users without scopes', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({ hits: [], found: 0 });

        await searchMcpResources(ernesto, 'test', { scopes: [] });

        const searchParams = mocks.search.mock.calls[0][0];
        expect(searchParams.filter_by).toContain('is_unrestricted:true');
    });

    it('post-filters documents requiring scopes user does not have', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({
            hits: [
                {
                    document: { uri: 'test://1', domain: 'test', name: 'Public', description: '', scopes: [], content_size: 0, child_count: 0 },
                    text_match_info: { score: 10 },
                    highlights: [],
                },
                {
                    document: { uri: 'test://2', domain: 'test', name: 'Admin', description: '', scopes: ['admin'], content_size: 0, child_count: 0 },
                    text_match_info: { score: 10 },
                    highlights: [],
                },
            ],
            found: 2,
        });

        const results = await searchMcpResources(ernesto, 'test', { scopes: ['read'] });
        // Only public doc should pass (no admin scope)
        expect(results).toHaveLength(1);
        expect(results[0].uri).toBe('test://1');
    });

    it('uses keyword mode settings', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({ hits: [], found: 0 });

        await searchMcpResources(ernesto, 'test', { mode: 'keyword' });

        const params = mocks.search.mock.calls[0][0];
        expect(params.num_typos).toBe(0);
        expect(params.prioritize_exact_match).toBe(true);
    });

    it('uses semantic mode settings', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({ hits: [], found: 0 });

        await searchMcpResources(ernesto, 'test', { mode: 'semantic' });

        const params = mocks.search.mock.calls[0][0];
        expect(params.num_typos).toBe(2);
        expect(params.prioritize_exact_match).toBe(false);
    });

    it('uses custom queryBy and weights', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({ hits: [], found: 0 });

        await searchMcpResources(ernesto, 'test', { queryBy: 'title,body', weights: '3,1' });

        const params = mocks.search.mock.calls[0][0];
        expect(params.query_by).toBe('title,body');
        expect(params.query_by_weights).toBe('3,1');
    });

    it('returns empty on 404 (collection not yet created)', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockRejectedValue({ httpStatus: 404 });

        const results = await searchMcpResources(ernesto, 'test');
        expect(results).toEqual([]);
    });

    it('returns empty on other errors', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockRejectedValue(new Error('connection timeout'));

        const results = await searchMcpResources(ernesto, 'test');
        expect(results).toEqual([]);
    });
});

describe('getMcpResourceStats', () => {
    it('returns total and byDomain counts', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({
            found: 100,
            facet_counts: [{
                field_name: 'domain',
                counts: [
                    { value: 'code', count: 50 },
                    { value: 'qa', count: 30 },
                ],
            }],
        });

        const stats = await getMcpResourceStats(ernesto);
        expect(stats).toEqual({
            total: 100,
            byDomain: { code: 50, qa: 30 },
        });
    });

    it('returns zero counts on 404', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockRejectedValue({ httpStatus: 404 });

        const stats = await getMcpResourceStats(ernesto);
        expect(stats).toEqual({ total: 0, byDomain: {} });
    });

    it('returns null on other errors', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockRejectedValue(new Error('connection error'));

        const stats = await getMcpResourceStats(ernesto);
        expect(stats).toBeNull();
    });
});

describe('getSourceFreshness', () => {
    it('returns age and document count for existing source', async () => {
        const indexedAt = Date.now() - 60000; // 1 minute ago
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({
            hits: [{ document: { indexed_at: indexedAt } }],
            found: 10,
        });

        const result = await getSourceFreshness(ernesto, 'source_1');
        expect(result).not.toBeNull();
        expect(result!.documentCount).toBe(10);
        expect(result!.ageMs).toBeGreaterThanOrEqual(60000);
    });

    it('returns null when no documents for source', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({ hits: [], found: 0 });

        const result = await getSourceFreshness(ernesto, 'nonexistent');
        expect(result).toBeNull();
    });

    it('returns null on 404', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockRejectedValue({ httpStatus: 404 });

        const result = await getSourceFreshness(ernesto, 'test');
        expect(result).toBeNull();
    });
});

describe('deleteSourceDocuments', () => {
    it('deletes documents by source_id filter', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.delete.mockResolvedValue({ num_deleted: 5 });

        const count = await deleteSourceDocuments(ernesto, 'source_1');
        expect(count).toBe(5);
        expect(mocks.delete).toHaveBeenCalledWith({ filter_by: 'source_id:=source_1' });
    });

    it('returns 0 on 404', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.delete.mockRejectedValue({ httpStatus: 404 });

        const count = await deleteSourceDocuments(ernesto, 'test');
        expect(count).toBe(0);
    });

    it('returns 0 on other errors', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.delete.mockRejectedValue(new Error('error'));

        const count = await deleteSourceDocuments(ernesto, 'test');
        expect(count).toBe(0);
    });
});

describe('getDocumentByUri', () => {
    it('retrieves document by base64-encoded URI', async () => {
        const { ernesto, mocks } = createMockErnesto();
        const doc = { uri: 'code://prs/123', name: 'PR 123' };
        mocks.retrieveDoc.mockResolvedValue(doc);

        const result = await getDocumentByUri(ernesto, 'code://prs/123');
        expect(result).toEqual(doc);
    });

    it('returns null on 404', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.retrieveDoc.mockRejectedValue({ httpStatus: 404 });

        const result = await getDocumentByUri(ernesto, 'nonexistent://uri');
        expect(result).toBeNull();
    });

    it('throws on non-404 errors', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.retrieveDoc.mockRejectedValue(new Error('server error'));

        await expect(getDocumentByUri(ernesto, 'test://uri')).rejects.toThrow('server error');
    });
});

describe('searchMcpResources with group_by', () => {
    it('passes group_by and group_limit to search params', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({ hits: [], found: 0 });

        await searchMcpResources(ernesto, 'test', { groupBy: 'domain', groupLimit: 3 });

        const params = mocks.search.mock.calls[0][0];
        expect(params.group_by).toBe('domain');
        expect(params.group_limit).toBe(3);
    });

    it('flattens grouped_hits into results', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({
            grouped_hits: [
                {
                    group_key: ['code'],
                    hits: [
                        {
                            document: { uri: 'code://prs/1', domain: 'code', name: 'PR 1', description: 'Fix bug', content_size: 100, child_count: 0, scopes: [] },
                            text_match_info: { score: 42 },
                            highlights: [],
                        },
                    ],
                },
                {
                    group_key: ['teams'],
                    hits: [
                        {
                            document: { uri: 'teams://tasks/1', domain: 'teams', name: 'Task 1', description: 'Feature', content_size: 50, child_count: 0, scopes: [] },
                            text_match_info: { score: 30 },
                            highlights: [],
                        },
                    ],
                },
            ],
            found: 2,
        });

        const results = await searchMcpResources(ernesto, 'test', { groupBy: 'domain', groupLimit: 3 });
        expect(results).toHaveLength(2);
        expect(results[0].domain).toBe('code');
        expect(results[1].domain).toBe('teams');
    });

    it('applies scope post-filtering on grouped results', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({
            grouped_hits: [
                {
                    group_key: ['code'],
                    hits: [
                        {
                            document: { uri: 'code://1', domain: 'code', name: 'Public', description: '', content_size: 0, child_count: 0, scopes: [] },
                            text_match_info: { score: 10 },
                            highlights: [],
                        },
                        {
                            document: { uri: 'code://2', domain: 'code', name: 'Admin', description: '', content_size: 0, child_count: 0, scopes: ['admin'] },
                            text_match_info: { score: 10 },
                            highlights: [],
                        },
                    ],
                },
            ],
            found: 2,
        });

        const results = await searchMcpResources(ernesto, 'test', { groupBy: 'domain', groupLimit: 3, scopes: ['read'] });
        expect(results).toHaveLength(1);
        expect(results[0].uri).toBe('code://1');
    });

    it('falls back to regular hits when no grouped_hits', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockResolvedValue({
            hits: [{
                document: { uri: 'test://1', domain: 'test', name: 'Test', description: '', content_size: 0, child_count: 0, scopes: [] },
                text_match_info: { score: 10 },
                highlights: [],
            }],
            found: 1,
        });

        const results = await searchMcpResources(ernesto, 'test', { groupBy: 'domain', groupLimit: 3 });
        expect(results).toHaveLength(1);
        expect(results[0].uri).toBe('test://1');
    });
});

describe('exportSourceDocuments', () => {
    it('paginates through all documents for a source', async () => {
        const { ernesto, mocks } = createMockErnesto();
        // First page: full
        mocks.search
            .mockResolvedValueOnce({
                hits: Array.from({ length: 250 }, (_, i) => ({ document: { id: `doc-${i}` } })),
            })
            // Second page: partial (end)
            .mockResolvedValueOnce({
                hits: [{ document: { id: 'doc-250' } }],
            });

        const docs = await exportSourceDocuments(ernesto, 'source_1');
        expect(docs).toHaveLength(251);
        expect(mocks.search).toHaveBeenCalledTimes(2);
    });

    it('returns empty array on 404', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockRejectedValue({ httpStatus: 404 });

        const docs = await exportSourceDocuments(ernesto, 'test');
        expect(docs).toEqual([]);
    });

    it('throws on non-404 errors', async () => {
        const { ernesto, mocks } = createMockErnesto();
        mocks.search.mockRejectedValue(new Error('timeout'));

        await expect(exportSourceDocuments(ernesto, 'test')).rejects.toThrow('timeout');
    });
});
