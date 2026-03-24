import { vi } from 'vitest';

vi.mock('../typesense/client', () => ({
    searchMcpResources: vi.fn(),
}));

import { searchResources, searchResourcesCrossDomain } from '../typesense/search';
import { searchMcpResources } from '../typesense/client';

const mockSearchMcpResources = vi.mocked(searchMcpResources);

describe('searchResources', () => {
    const mockErnesto = {} as any;

    beforeEach(() => {
        mockSearchMcpResources.mockReset();
        mockSearchMcpResources.mockResolvedValue([]);
    });

    it('searches with default segment when none provided', async () => {
        await searchResources(mockErnesto, { query: 'test', domain: 'code' });

        expect(mockSearchMcpResources).toHaveBeenCalledWith(
            mockErnesto,
            'test',
            expect.objectContaining({ domain: 'code', mode: 'semantic' }),
        );
    });

    it('returns mapped ResourceSearchResults', async () => {
        mockSearchMcpResources.mockResolvedValue([
            { uri: 'code://prs/1', description: 'PR 1', domain: 'code', name: 'PR', content_size: 100, child_count: 0, relevance: 10 },
        ]);

        const results = await searchResources(mockErnesto, { query: 'test', domain: 'code' });
        expect(results).toHaveLength(1);
        expect(results[0]).toEqual({
            uri: 'code://prs/1',
            description: 'PR 1',
            segment: 'resources',
        });
    });

    it('uses custom segments sorted by priority', async () => {
        const segments = [
            { name: 'low-priority', filter: 'type:=doc', limit: 5, description: 'Docs', priority: 2 },
            { name: 'high-priority', filter: 'type:=tool', limit: 10, description: 'Tools', priority: 1 },
        ];

        await searchResources(mockErnesto, { query: 'test', domain: 'code', segments });

        // High priority searched first
        expect(mockSearchMcpResources).toHaveBeenCalledTimes(2);
        const firstCallFilter = mockSearchMcpResources.mock.calls[0][2];
        expect(firstCallFilter).toEqual(expect.objectContaining({ limit: 10, filterBy: 'type:=tool' }));
    });

    it('passes queryBy and weights to client', async () => {
        await searchResources(mockErnesto, {
            query: 'test',
            domain: 'code',
            queryBy: 'title,body',
            weights: '3,1',
        });

        expect(mockSearchMcpResources).toHaveBeenCalledWith(
            mockErnesto,
            'test',
            expect.objectContaining({ queryBy: 'title,body', weights: '3,1' }),
        );
    });

    it('passes scopes to client', async () => {
        await searchResources(mockErnesto, {
            query: 'test',
            domain: 'code',
            scopes: ['admin'],
        });

        expect(mockSearchMcpResources).toHaveBeenCalledWith(
            mockErnesto,
            'test',
            expect.objectContaining({ scopes: ['admin'] }),
        );
    });

    it('isolates errors per segment — one failing segment does not break others', async () => {
        const segments = [
            { name: 'working', filter: '', limit: 5, description: '', priority: 1 },
            { name: 'broken', filter: 'bad_filter', limit: 5, description: '', priority: 2 },
        ];

        mockSearchMcpResources
            .mockResolvedValueOnce([
                { uri: 'test://1', description: 'Result', domain: 'test', name: 'R', content_size: 1, child_count: 0, relevance: 5 },
            ])
            .mockRejectedValueOnce(new Error('Search failed'));

        const results = await searchResources(mockErnesto, { query: 'test', domain: 'test', segments });
        expect(results).toHaveLength(1);
        expect(results[0].segment).toBe('working');
    });

    it('returns empty description for results without description', async () => {
        mockSearchMcpResources.mockResolvedValue([
            { uri: 'test://1', domain: 'test', name: 'R', content_size: 1, child_count: 0, relevance: 5 },
        ]);

        const results = await searchResources(mockErnesto, { query: 'test', domain: 'test' });
        expect(results[0].description).toBe('');
    });
});

describe('searchResourcesCrossDomain', () => {
    const mockErnesto = {} as any;

    beforeEach(() => {
        mockSearchMcpResources.mockReset();
        mockSearchMcpResources.mockResolvedValue([]);
    });

    it('calls searchMcpResources with groupBy and groupLimit', async () => {
        await searchResourcesCrossDomain(mockErnesto, { query: 'test', groupLimit: 3 });

        expect(mockSearchMcpResources).toHaveBeenCalledWith(
            mockErnesto,
            'test',
            expect.objectContaining({
                groupBy: 'domain',
                groupLimit: 3,
                mode: 'semantic',
            }),
        );
    });

    it('returns ResourceSearchResult with domain field', async () => {
        mockSearchMcpResources.mockResolvedValue([
            { uri: 'code://prs/1', description: 'Fix bug', domain: 'code', name: 'PR 1', content_size: 100, child_count: 0, relevance: 42 },
            { uri: 'teams://tasks/1', description: 'Feature task', domain: 'teams', name: 'Task 1', content_size: 50, child_count: 0, relevance: 30 },
        ]);

        const results = await searchResourcesCrossDomain(mockErnesto, { query: 'test' });

        expect(results).toHaveLength(2);
        expect(results[0]).toEqual({
            uri: 'code://prs/1',
            description: 'Fix bug',
            segment: 'resources',
            domain: 'code',
        });
        expect(results[1].domain).toBe('teams');
    });

    it('passes scopes to searchMcpResources', async () => {
        await searchResourcesCrossDomain(mockErnesto, { query: 'test', scopes: ['admin'] });

        expect(mockSearchMcpResources).toHaveBeenCalledWith(
            mockErnesto,
            'test',
            expect.objectContaining({ scopes: ['admin'] }),
        );
    });

    it('uses default groupLimit of 3', async () => {
        await searchResourcesCrossDomain(mockErnesto, { query: 'test' });

        expect(mockSearchMcpResources).toHaveBeenCalledWith(
            mockErnesto,
            'test',
            expect.objectContaining({ groupLimit: 3 }),
        );
    });

    it('returns empty array on error', async () => {
        mockSearchMcpResources.mockRejectedValue(new Error('connection failed'));

        const results = await searchResourcesCrossDomain(mockErnesto, { query: 'test' });
        expect(results).toEqual([]);
    });
});
