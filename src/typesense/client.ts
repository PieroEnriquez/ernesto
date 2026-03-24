/**
 * Typesense Client for MCP Resources
 * Handles collection management, indexing, and search operations.
 */

import debug from 'debug';
import { mcpResourcesSchema, MCP_RESOURCES_COLLECTION, McpResourceDocument, McpResourceSearchResult } from './schema';
import type { Ernesto } from '../Ernesto';
import { SearchParams } from 'typesense/lib/Typesense/Types';

const log = debug('client');

/**
 * Get or create the MCP resources collection
 */
async function ensureMcpResourcesCollection(ernesto: Ernesto): Promise<void> {
    try {
        await ernesto.typesense.collections(MCP_RESOURCES_COLLECTION).retrieve();
        log('MCP resources collection already exists');
    } catch (error) {
        if (error.httpStatus === 404) {
            log('Creating MCP resources collection');
            await ernesto.typesense.collections().create(mcpResourcesSchema);
            log('MCP resources collection created successfully');
        } else {
            log('Failed to check MCP resources collection', { error });
            throw error;
        }
    }
}

/**
 * Index a batch of MCP resources
 * Uses upsert to handle updates gracefully
 */
export async function indexMcpResources(ernesto: Ernesto, documents: McpResourceDocument[]): Promise<{ success: number; failed: number }> {
    if (documents.length === 0) {
        return { success: 0, failed: 0 };
    }

    try {
        await ensureMcpResourcesCollection(ernesto);

        const result = await ernesto.typesense.collections(MCP_RESOURCES_COLLECTION).documents().import(documents, { action: 'upsert' });

        const results = Array.isArray(result) ? result : [result];
        const success = results.filter((r) => r.success === true).length;
        const failed = results.filter((r) => r.success === false).length;

        if (failed > 0) {
            log('Some documents failed to index', { success, failed });
        } else {
            log('Successfully indexed documents', { count: success });
        }

        return { success, failed };
    } catch (error) {
        log('Failed to index MCP resources', { error, documentCount: documents.length });
        return { success: 0, failed: documents.length };
    }
}

/**
 * Clear all documents from the collection
 * Used before full re-indexing to remove stale data
 */
export async function clearAllResources(ernesto: Ernesto): Promise<void> {
    try {
        await ernesto.typesense.collections(MCP_RESOURCES_COLLECTION).delete();
        log('Deleted MCP resources collection');

        await ernesto.typesense.collections().create(mcpResourcesSchema);
        log('Recreated MCP resources collection with clean schema');
    } catch (error) {
        if (error.httpStatus !== 404) {
            log('Failed to clear all resources', { error });
            throw error;
        }
    }
}

/**
 * Options for searchMcpResources
 */
export interface SearchMcpResourcesOptions {
    domain?: string;
    limit?: number;
    mode?: 'semantic' | 'keyword' | 'hybrid';
    queryBy?: string;
    weights?: string;
    filterBy?: string;
    scopes?: string[];
    /** Typesense group_by field for balanced cross-domain results */
    groupBy?: string;
    /** Max results per group when groupBy is set */
    groupLimit?: number;
}

/**
 * Search for MCP resources
 */
export async function searchMcpResources(
    ernesto: Ernesto,
    query: string,
    options: SearchMcpResourcesOptions = {},
): Promise<McpResourceSearchResult[]> {
    const { domain, limit = 10, mode = 'hybrid', queryBy = 'content,name,description', weights, filterBy, scopes, groupBy, groupLimit } = options;

    try {
        // Build filter
        const filters: string[] = [];
        if (domain) filters.push(`domain:=${domain}`);
        if (filterBy) filters.push(filterBy);

        // Scope-based pre-filtering:
        // - Unrestricted docs (is_unrestricted:true) are always included
        // - If user has scopes, also include docs with ANY matching scope
        // - Post-filter will ensure user has ALL required scopes
        const userScopes = scopes || [];
        if (userScopes.length > 0) {
            // Get unrestricted docs OR docs with at least one matching scope
            filters.push(`(is_unrestricted:true || scopes:[${userScopes.join(',')}])`);
        } else {
            // User has no scopes = only see unrestricted docs
            filters.push('is_unrestricted:true');
        }

        const filter_by = filters.join(' && ');

        // Configure search params based on mode and domain config
        const searchParams: SearchParams<McpResourceDocument> = {
            q: query,
            query_by: queryBy,
            filter_by,
            per_page: limit,
            highlight_full_fields: 'content,description',
            highlight_affix_num_tokens: 20,
            // Natural ranking using pre-computed quality scores:
            // 1. _text_match - base relevance from query matching (using domain-specific weights)
            // 2. quality_score:desc - pre-computed quality (structure, type, usage within domain)
            // 3. indexed_at:desc - freshness as final tie-breaker
            sort_by: '_text_match:desc,quality_score:desc,indexed_at:desc',
        };

        // Default weights: content-first (4,2,1 for content,name,description)
        searchParams.query_by_weights = weights || '4,2,1';

        // Apply grouping for balanced cross-domain results
        if (groupBy) {
            (searchParams as any).group_by = groupBy;
            if (groupLimit) {
                (searchParams as any).group_limit = groupLimit;
            }
        }

        if (mode === 'keyword') {
            // Keyword mode: Prioritize exact matches heavily
            searchParams.prioritize_exact_match = true;
            searchParams.prioritize_token_position = true;
            searchParams.typo_tokens_threshold = 0; // No typo tolerance
            searchParams.num_typos = 0; // Strict matching
        } else if (mode === 'semantic') {
            // Semantic mode: Use vector search / semantic ranking
            searchParams.prioritize_exact_match = false;
            searchParams.prioritize_token_position = false;
            searchParams.num_typos = 2; // More typo tolerance for semantic search
        } else {
            // Hybrid mode (default): Balance both
            searchParams.prioritize_exact_match = true; // Exact phrases rank higher
            searchParams.prioritize_token_position = true; // Early matches rank higher
            searchParams.num_typos = 1; // Some typo tolerance
        }

        const result = await ernesto.typesense.collections<McpResourceDocument>(MCP_RESOURCES_COLLECTION).documents().search(searchParams);

        // Handle grouped results (group_by mode)
        if (groupBy && (result as any).grouped_hits) {
            return flattenGroupedHits((result as any).grouped_hits, userScopes);
        }

        if (!result.hits || result.hits.length === 0) {
            return [];
        }

        // POST-FILTER: Ensure user has ALL scopes required by document
        // - Empty scopes = unrestricted = visible to everyone
        // - Non-empty scopes = restricted = user must have ALL of them
        const filteredHits = result.hits.filter((hit) => {
            const docScopes = hit.document.scopes || [];

            // Empty scopes = unrestricted = visible to everyone
            if (docScopes.length === 0) return true;

            // Document has scopes = user must have ALL of them
            return docScopes.every((scope) => userScopes.includes(scope));
        });

        // Transform filtered results
        return filteredHits.map((hit) => {
            const doc = hit.document;
            const highlights = hit.highlights;

            // Extract snippets from both description and content highlights
            const descHighlight = highlights?.find((h) => h.field === 'description');
            const contentHighlight = highlights?.find((h) => h.field === 'content');

            return {
                uri: doc.uri,
                domain: doc.domain,
                name: doc.name,
                description: doc.description,
                content_size: doc.content_size,
                child_count: doc.child_count,
                relevance: Number(hit.text_match_info?.score) || 0,
                descriptionSnippet: descHighlight?.snippet,
                contentSnippet: contentHighlight?.snippet,
            };
        });
    } catch (error) {
        // If collection doesn't exist, return empty
        if (error.httpStatus === 404) {
            log('MCP resources collection not yet created');
            return [];
        }

        log('Failed to search MCP resources', { error, query, options });
        return [];
    }
}

/**
 * Flatten Typesense grouped_hits into McpResourceSearchResult[],
 * applying scope post-filtering on each hit.
 */
function flattenGroupedHits(groupedHits: any[], userScopes: string[]): McpResourceSearchResult[] {
    const results: McpResourceSearchResult[] = [];

    for (const group of groupedHits) {
        const hits = group.hits || [];
        for (const hit of hits) {
            const doc = hit.document;
            const docScopes = doc.scopes || [];

            // Scope post-filter
            if (docScopes.length > 0 && !docScopes.every((scope: string) => userScopes.includes(scope))) {
                continue;
            }

            const highlights = hit.highlights;
            const descHighlight = highlights?.find((h: any) => h.field === 'description');
            const contentHighlight = highlights?.find((h: any) => h.field === 'content');

            results.push({
                uri: doc.uri,
                domain: doc.domain,
                name: doc.name,
                description: doc.description,
                content_size: doc.content_size,
                child_count: doc.child_count,
                relevance: Number(hit.text_match_info?.score) || 0,
                descriptionSnippet: descHighlight?.snippet,
                contentSnippet: contentHighlight?.snippet,
            });
        }
    }

    return results;
}

/**
 * Get statistics about indexed resources
 */
export async function getMcpResourceStats(ernesto: Ernesto): Promise<{
    total: number;
    byDomain: Record<string, number>;
} | null> {
    try {
        // Get counts by domain using facet search
        const result = await ernesto.typesense.collections(MCP_RESOURCES_COLLECTION).documents().search({
            q: '*',
            query_by: 'name',
            facet_by: 'domain',
            per_page: 0,
        });

        const byDomain: Record<string, number> = {};
        if (result.facet_counts) {
            for (const facet of result.facet_counts) {
                if (facet.field_name === 'domain' && facet.counts) {
                    for (const count of facet.counts) {
                        byDomain[count.value] = count.count;
                    }
                }
            }
        }

        return {
            total: result.found || 0,
            byDomain,
        };
    } catch (error) {
        if (error.httpStatus === 404) {
            return { total: 0, byDomain: {} };
        }
        log('Failed to get MCP resource stats', { error });
        return null;
    }
}

/**
 * Check if a specific source has fresh data in the index
 *
 * Returns the age of the oldest document for this source.
 * Used to decide whether to skip fetching from third-party sources.
 *
 * @param ernesto - Ernesto instance
 * @param sourceId - Source identifier
 * @returns Age in milliseconds, document count, or null if no documents for this source
 */
export async function getSourceFreshness(ernesto: Ernesto, sourceId: string): Promise<{ ageMs: number; documentCount: number } | null> {
    try {
        // Get oldest document for this source
        const result = await ernesto.typesense
            .collections(MCP_RESOURCES_COLLECTION)
            .documents()
            .search({
                q: '*',
                query_by: 'name',
                filter_by: `source_id:=${sourceId}`,
                per_page: 1,
                sort_by: 'indexed_at:asc',
            });

        if (!result.hits || result.hits.length === 0) {
            return null; // No documents for this source
        }

        const oldestDoc = result.hits[0].document as McpResourceDocument;
        const ageMs = Date.now() - oldestDoc.indexed_at;
        const documentCount = result.found || 0;

        return { ageMs, documentCount };
    } catch (error) {
        if (error.httpStatus === 404) {
            return null;
        }
        log('Failed to get source freshness', { error, sourceId });
        return null;
    }
}

/**
 * Delete all documents for a specific source
 *
 * Used before re-indexing a source to remove stale data.
 *
 * @param ernesto - Ernesto instance
 * @param sourceId - Source identifier to delete documents for
 * @returns Number of documents deleted
 */
export async function deleteSourceDocuments(ernesto: Ernesto, sourceId: string): Promise<number> {
    try {
        const result = await ernesto.typesense
            .collections(MCP_RESOURCES_COLLECTION)
            .documents()
            .delete({ filter_by: `source_id:=${sourceId}` });

        const deletedCount = result.num_deleted || 0;
        log('Deleted documents for source', { sourceId, deletedCount });
        return deletedCount;
    } catch (error) {
        if (error.httpStatus === 404) {
            return 0;
        }
        log('Failed to delete source documents', { error, sourceId });
        return 0;
    }
}

/**
 * Fetch a single document by URI
 *
 * Used for on-demand content retrieval instead of keeping all content in memory.
 *
 * @param ernesto - Ernesto instance
 * @param uri - Route URI
 * @returns Document content or null if not found
 */
export async function getDocumentByUri(ernesto: Ernesto, uri: string): Promise<McpResourceDocument | null> {
    try {
        // Use document ID lookup (base64 of URI) for exact match
        // This is more reliable than filter_by for URIs with special characters
        const docId = Buffer.from(uri).toString('base64');
        const doc = await ernesto.typesense.collections(MCP_RESOURCES_COLLECTION).documents(docId).retrieve();

        return doc as McpResourceDocument;
    } catch (error) {
        if (error.httpStatus === 404) {
            return null;
        }
        throw error;
    }
}

/**
 * Export documents for a specific source
 *
 * Used to load fresh source data from index into cache without re-fetching.
 *
 * @param ernesto - Ernesto instance
 * @param sourceId - Source identifier to filter by
 * @returns Array of indexed documents for this source
 */
export async function exportSourceDocuments(ernesto: Ernesto, sourceId: string): Promise<McpResourceDocument[]> {
    try {
        const documents: McpResourceDocument[] = [];
        const pageSize = 250;
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const result = await ernesto.typesense
                .collections(MCP_RESOURCES_COLLECTION)
                .documents()
                .search({
                    q: '*',
                    query_by: 'name',
                    filter_by: `source_id:=${sourceId}`,
                    per_page: pageSize,
                    page,
                });

            if (result.hits && result.hits.length > 0) {
                for (const hit of result.hits) {
                    documents.push(hit.document as McpResourceDocument);
                }
                hasMore = result.hits.length === pageSize;
                page++;
            } else {
                hasMore = false;
            }
        }

        log('Exported source documents from index', {
            sourceId,
            count: documents.length,
        });

        return documents;
    } catch (error) {
        if (error.httpStatus === 404) {
            return [];
        }
        log('Failed to export source documents from index', { error, sourceId });
        throw error;
    }
}
