/**
 * Lifecycle Service
 * Handles operational lifecycle tasks
 */

import debug from 'debug';
import { clearAllResources, deleteSourceDocuments, getSourceFreshness } from './typesense/client';
import { ContentPipeline } from './pipelines';
import type { Ernesto } from './Ernesto';

const log = debug('LifecycleService');

export class LifecycleService {
    private ernesto: Ernesto;

    constructor(ernesto: Ernesto) {
        this.ernesto = ernesto;
    }

    async restart(): Promise<{
        success: boolean;
        skillCount: number;
        duration: number;
    }> {
        const startTime = Date.now();
        log('Restarting...');

        try {
            await this.ernesto.initialize();

            const duration = Date.now() - startTime;
            return {
                success: true,
                skillCount: this.ernesto.skillRegistry.getAll().length,
                duration,
            };
        } catch (error) {
            log('Restart failed', { error });
            return {
                success: false,
                skillCount: this.ernesto.skillRegistry.getAll().length,
                duration: Date.now() - startTime,
            };
        }
    }

    async wipeIndexAndRebuild(): Promise<{
        success: boolean;
        skillCount: number;
        duration: number;
    }> {
        const startTime = Date.now();
        log('Wiping index and rebuilding...');

        try {
            await clearAllResources(this.ernesto as any);

            await this.ernesto.initialize();

            const duration = Date.now() - startTime;
            log('Wipe and rebuild complete', {
                duration,
                skillCount: this.ernesto.skillRegistry.getAll().length,
            });

            return {
                success: true,
                skillCount: this.ernesto.skillRegistry.getAll().length,
                duration,
            };
        } catch (error) {
            log('Wipe and rebuild failed', { error });
            return {
                success: false,
                skillCount: this.ernesto.skillRegistry.getAll().length,
                duration: Date.now() - startTime,
            };
        }
    }

    async rebuildFromIndex(): Promise<{
        success: boolean;
        skillsRebuilt: number;
        bySkill: Record<string, number>;
        error?: string;
    }> {
        try {
            await this.restart();

            const bySkill: Record<string, number> = {};
            for (const skill of this.ernesto.skillRegistry.getAll()) {
                bySkill[skill.name] = skill.tools.length;
            }

            return {
                success: true,
                skillsRebuilt: this.ernesto.skillRegistry.getAll().length,
                bySkill,
            };
        } catch (error: any) {
            return {
                success: false,
                skillsRebuilt: 0,
                bySkill: {},
                error: error.message,
            };
        }
    }

    async refreshSource(sourceId: string): Promise<{
        success: boolean;
        resourceCount: number;
        message: string;
    }> {
        const sourceInfo = this.ernesto.skillRegistry.findSource(sourceId);
        if (!sourceInfo) {
            return {
                success: false,
                resourceCount: 0,
                message: `Source not found: ${sourceId}`,
            };
        }

        const { skillName, extractor } = sourceInfo;

        try {
            const pipeline = new ContentPipeline({
                source: extractor.source,
                formats: extractor.formats,
                basePath: extractor.basePath,
            });

            const resources = await pipeline.fetchResources();
            if (resources.length === 0) {
                return { success: true, resourceCount: 0, message: 'No resources found' };
            }

            await deleteSourceDocuments(this.ernesto as any, sourceId);
            await this.ernesto.indexResources(sourceId, skillName, extractor, resources);

            // v2: Also write resources as files to master FS
            await this.ernesto.writeResourcesToFS(skillName, resources).catch(err => {
                log('Failed to write resources to FS (non-fatal)', { skillName, error: err });
            });

            return {
                success: true,
                resourceCount: resources.length,
                message: `Refreshed ${resources.length} resources`,
            };
        } catch (error: any) {
            log('Refresh failed', { sourceId, error });
            return {
                success: false,
                resourceCount: 0,
                message: error.message || 'Unknown error',
            };
        }
    }

    async refreshStaleSources(): Promise<{
        checked: number;
        refreshed: number;
        failed: number;
    }> {
        const stats = { checked: 0, refreshed: 0, failed: 0 };

        for (const source of this.ernesto.skillRegistry.getAllSources()) {
            if (source.isLocal) continue;

            stats.checked++;

            try {
                const freshness = await getSourceFreshness(this.ernesto as any, source.sourceId);
                const isStale = !freshness || freshness.ageMs >= source.cacheTtlMs;

                if (isStale) {
                    log('Refreshing stale source', {
                        sourceId: source.sourceId,
                        skill: source.skill,
                        ageMinutes: freshness ? Math.round(freshness.ageMs / 60000) : null,
                        ttlMinutes: Math.round(source.cacheTtlMs / 60000),
                    });

                    await this.refreshSource(source.sourceId);
                    stats.refreshed++;
                }
            } catch (error) {
                log('Failed to refresh source', {
                    sourceId: source.sourceId,
                    skill: source.skill,
                    error,
                });
                stats.failed++;
            }
        }

        return stats;
    }
}
