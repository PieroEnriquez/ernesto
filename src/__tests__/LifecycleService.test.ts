import { vi } from 'vitest';

vi.mock('../typesense/client', () => ({
    clearAllResources: vi.fn(),
    deleteSourceDocuments: vi.fn(),
    getSourceFreshness: vi.fn(),
}));

import { LifecycleService } from '../LifecycleService';
import { clearAllResources, deleteSourceDocuments, getSourceFreshness } from '../typesense/client';

const mockClearAll = vi.mocked(clearAllResources);
const mockDeleteSource = vi.mocked(deleteSourceDocuments);
const mockGetFreshness = vi.mocked(getSourceFreshness);

function createMockErnesto(overrides: Record<string, any> = {}) {
    return {
        initialize: vi.fn().mockResolvedValue(undefined),
        skillRegistry: {
            getAll: vi.fn().mockReturnValue([]),
            findSource: vi.fn().mockReturnValue(null),
            getAllSources: vi.fn().mockReturnValue([]),
        },
        indexResources: vi.fn().mockResolvedValue(undefined),
        writeResourcesToFS: vi.fn().mockResolvedValue(undefined),
        ...overrides,
    } as any;
}

describe('LifecycleService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('restart', () => {
        it('calls ernesto.initialize and returns success', async () => {
            const ernesto = createMockErnesto();
            ernesto.skillRegistry.getAll.mockReturnValue([{ name: 's1' }, { name: 's2' }]);
            const service = new LifecycleService(ernesto);

            const result = await service.restart();
            expect(result.success).toBe(true);
            expect(result.skillCount).toBe(2);
            expect(result.duration).toBeGreaterThanOrEqual(0);
            expect(ernesto.initialize).toHaveBeenCalled();
        });

        it('returns failure when initialize throws', async () => {
            const ernesto = createMockErnesto();
            ernesto.initialize.mockRejectedValue(new Error('init failed'));
            const service = new LifecycleService(ernesto);

            const result = await service.restart();
            expect(result.success).toBe(false);
        });
    });

    describe('wipeIndexAndRebuild', () => {
        it('clears all resources then initializes', async () => {
            const ernesto = createMockErnesto();
            const service = new LifecycleService(ernesto);

            const result = await service.wipeIndexAndRebuild();

            expect(mockClearAll).toHaveBeenCalledWith(ernesto);
            expect(ernesto.initialize).toHaveBeenCalled();
            expect(result.success).toBe(true);
        });

        it('returns failure when clearAllResources throws', async () => {
            const ernesto = createMockErnesto();
            mockClearAll.mockRejectedValue(new Error('clear failed'));
            const service = new LifecycleService(ernesto);

            const result = await service.wipeIndexAndRebuild();
            expect(result.success).toBe(false);
        });
    });

    describe('rebuildFromIndex', () => {
        it('restarts and returns skill counts', async () => {
            const ernesto = createMockErnesto();
            ernesto.skillRegistry.getAll.mockReturnValue([
                { name: 'redshift', tools: [1, 2] },
                { name: 'code', tools: [1] },
            ]);
            const service = new LifecycleService(ernesto);

            const result = await service.rebuildFromIndex();
            expect(result.success).toBe(true);
            expect(result.skillsRebuilt).toBe(2);
            expect(result.bySkill).toEqual({ redshift: 2, code: 1 });
        });

        it('returns failure when an unexpected error propagates', async () => {
            const ernesto = createMockErnesto();
            // Make getAll throw AFTER restart (restart catches its own errors)
            ernesto.skillRegistry.getAll.mockImplementation(() => { throw new Error('registry corrupted'); });
            const service = new LifecycleService(ernesto);

            const result = await service.rebuildFromIndex();
            expect(result.success).toBe(false);
            expect(result.error).toBe('registry corrupted');
        });
    });

    describe('refreshSource', () => {
        it('returns not found for unknown source', async () => {
            const ernesto = createMockErnesto();
            const service = new LifecycleService(ernesto);

            const result = await service.refreshSource('nonexistent');
            expect(result.success).toBe(false);
            expect(result.message).toContain('not found');
        });

        it('fetches, deletes old, and indexes new resources', async () => {
            const mockSource = {
                name: 'test-source',
                listDocuments: vi.fn().mockResolvedValue([
                    { id: '1', name: 'Doc', path: '/doc', contentType: 'text/plain' },
                ]),
                fetchContent: vi.fn().mockResolvedValue({ content: 'content', contentType: 'text/plain' }),
            };
            const mockFormat = {
                name: 'test-format',
                canHandle: () => true,
                parse: () => [{ id: 'node', name: 'Node', path: '/node', content: 'content' }],
            };
            const ernesto = createMockErnesto();
            ernesto.skillRegistry.findSource.mockReturnValue({
                skillName: 'test-skill',
                extractor: { source: mockSource, formats: [mockFormat], basePath: '/resources' },
            });
            const service = new LifecycleService(ernesto);

            const result = await service.refreshSource('source_1');

            expect(result.success).toBe(true);
            expect(result.resourceCount).toBe(1);
            expect(mockDeleteSource).toHaveBeenCalledWith(ernesto, 'source_1');
            expect(ernesto.indexResources).toHaveBeenCalled();
        });

        it('returns success with zero count when no resources found', async () => {
            const ernesto = createMockErnesto();
            ernesto.skillRegistry.findSource.mockReturnValue({
                skillName: 'test',
                extractor: {
                    source: { name: 's', listDocuments: vi.fn().mockResolvedValue([]), fetchContent: vi.fn() },
                    formats: [{ name: 'f', canHandle: () => true, parse: () => [] }],
                },
            });
            const service = new LifecycleService(ernesto);

            const result = await service.refreshSource('empty_source');
            expect(result.success).toBe(true);
            expect(result.resourceCount).toBe(0);
        });

        it('returns failure on fetch error', async () => {
            const ernesto = createMockErnesto();
            ernesto.skillRegistry.findSource.mockReturnValue({
                skillName: 'test',
                extractor: {
                    source: { name: 's', listDocuments: vi.fn().mockRejectedValue(new Error('network error')), fetchContent: vi.fn() },
                    formats: [{ name: 'f', canHandle: () => true, parse: () => [] }],
                },
            });
            const service = new LifecycleService(ernesto);

            const result = await service.refreshSource('bad_source');
            expect(result.success).toBe(false);
            expect(result.message).toContain('ContentPipeline failed');
        });
    });

    describe('refreshStaleSources', () => {
        it('skips local sources', async () => {
            const ernesto = createMockErnesto();
            ernesto.skillRegistry.getAllSources.mockReturnValue([
                { sourceId: 'local_1', skill: 'test', isLocal: true, cacheTtlMs: 60000 },
            ]);
            const service = new LifecycleService(ernesto);

            const result = await service.refreshStaleSources();
            expect(result.checked).toBe(0);
            expect(mockGetFreshness).not.toHaveBeenCalled();
        });

        it('refreshes sources with no freshness data', async () => {
            const ernesto = createMockErnesto();
            ernesto.skillRegistry.getAllSources.mockReturnValue([
                { sourceId: 'github_1', skill: 'code', isLocal: false, cacheTtlMs: 60000 },
            ]);
            ernesto.skillRegistry.findSource.mockReturnValue({
                skillName: 'code',
                extractor: {
                    source: { name: 's', listDocuments: vi.fn().mockResolvedValue([]), fetchContent: vi.fn() },
                    formats: [{ name: 'f', canHandle: () => true, parse: () => [] }],
                },
            });
            mockGetFreshness.mockResolvedValue(null);
            const service = new LifecycleService(ernesto);

            const result = await service.refreshStaleSources();
            expect(result.checked).toBe(1);
            expect(result.refreshed).toBe(1);
        });

        it('skips fresh sources', async () => {
            const ernesto = createMockErnesto();
            ernesto.skillRegistry.getAllSources.mockReturnValue([
                { sourceId: 'github_1', skill: 'code', isLocal: false, cacheTtlMs: 600000 }, // 10 min TTL
            ]);
            mockGetFreshness.mockResolvedValue({ ageMs: 30000, documentCount: 50 }); // 30s old
            const service = new LifecycleService(ernesto);

            const result = await service.refreshStaleSources();
            expect(result.checked).toBe(1);
            expect(result.refreshed).toBe(0);
        });

        it('counts failures without stopping other source checks', async () => {
            const ernesto = createMockErnesto();
            ernesto.skillRegistry.getAllSources.mockReturnValue([
                { sourceId: 'source_1', skill: 'a', isLocal: false, cacheTtlMs: 1000 },
                { sourceId: 'source_2', skill: 'b', isLocal: false, cacheTtlMs: 1000 },
            ]);
            mockGetFreshness
                .mockRejectedValueOnce(new Error('check failed'))
                .mockResolvedValueOnce(null);
            // Second source: findSource returns valid config
            ernesto.skillRegistry.findSource.mockReturnValue({
                skillName: 'b',
                extractor: {
                    source: { name: 's', listDocuments: vi.fn().mockResolvedValue([]), fetchContent: vi.fn() },
                    formats: [{ name: 'f', canHandle: () => true, parse: () => [] }],
                },
            });

            const service = new LifecycleService(ernesto);
            const result = await service.refreshStaleSources();

            expect(result.checked).toBe(2);
            expect(result.failed).toBe(1);
            expect(result.refreshed).toBe(1);
        });
    });
});
