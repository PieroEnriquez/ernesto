/**
 * Typesense Resource Search
 *
 * Pure Typesense search functionality for resources.
 * Tools are NOT in Typesense - they live in SkillRegistry.
 */

import { SearchSegment } from '../skill';
import { searchMcpResources } from './client';
import type { McpResourceSearchResult } from './schema';
import type { Ernesto } from '../Ernesto';
import debug from 'debug';

const log = debug('search');

/**
 * Default search segment for resources
 */
const DEFAULT_SEGMENTS: SearchSegment[] = [
    {
        name: 'resources',
        filter: '',
        limit: 20,
        description: 'Resources extracted from sources',
        priority: 1,
    },
];

export interface ResourceSearchResult {
    uri: string;
    description: string;
    segment: string;
    domain?: string;
}

export interface ResourceSearchOptions {
    query: string;
    domain: string;
    segments?: SearchSegment[];
    queryBy?: string; // Comma-separated field names
    weights?: string;
    scopes?: string[];
}

/**
 * Search resources in Typesense for a specific domain
 *
 * This is the pure Typesense search - no route composition.
 * Returns matching resources ranked by relevance.
 */
export async function searchResources(ernesto: Ernesto, options: ResourceSearchOptions): Promise<ResourceSearchResult[]> {
    const { query, domain, segments, queryBy, weights, scopes } = options;

    const activeSegments = segments && segments.length > 0 ? segments : DEFAULT_SEGMENTS;

    const results: ResourceSearchResult[] = [];
    const sortedSegments = [...activeSegments].sort((a, b) => a.priority - b.priority);

    for (const segment of sortedSegments) {
        try {
            const segmentResults = await searchMcpResources(ernesto, query, {
                domain,
                limit: segment.limit,
                mode: 'semantic',
                filterBy: segment.filter || undefined,
                queryBy,
                weights,
                scopes,
            });

            for (const result of segmentResults) {
                results.push({
                    uri: result.uri,
                    description: result.description || '',
                    segment: segment.name,
                });
            }
        } catch (error) {
            log('Segment search failed', {
                domain,
                segment: segment.name,
                error: error.message,
            });
        }
    }

    return results;
}

/**
 * Options for cross-domain resource search
 */
export interface CrossDomainSearchOptions {
    query: string;
    /** Max results per domain (via Typesense group_by) */
    groupLimit?: number;
    /** Total result limit */
    limit?: number;
    scopes?: string[];
}

/**
 * Search resources across all domains with balanced results.
 *
 * Uses Typesense group_by=domain to ensure each domain gets at most
 * `groupLimit` results, preventing a single domain from hogging all slots.
 * Single query instead of N per-domain queries.
 */
export async function searchResourcesCrossDomain(
    ernesto: Ernesto,
    options: CrossDomainSearchOptions,
): Promise<ResourceSearchResult[]> {
    const { query, groupLimit = 3, limit = 50, scopes } = options;

    try {
        const rawResults: McpResourceSearchResult[] = await searchMcpResources(ernesto, query, {
            limit,
            mode: 'semantic',
            scopes,
            groupBy: 'domain',
            groupLimit,
        });

        return rawResults.map((r) => ({
            uri: r.uri,
            description: r.description || '',
            segment: 'resources',
            domain: r.domain,
        }));
    } catch (error) {
        log('Cross-domain search failed', { query, error: error.message });
        return [];
    }
}
