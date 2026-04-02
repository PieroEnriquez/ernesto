/**
 * Search Provider Interface
 *
 * Optional search capability for Ernesto deployments.
 * The deployer provides an implementation (Typesense, SQLite FTS, Elasticsearch, etc.).
 * Tools access search via ctx.ernesto.search.
 *
 * Without a search provider, Ernesto works fully — agents use workspace files
 * and Read/Grep for content discovery instead of semantic search.
 */

/**
 * Search result from a provider.
 */
export interface SearchResult {
    /** Resource URI (e.g., "redshift://resources/facts/orders/columns/amount") */
    uri: string;
    /** Domain/skill that owns this resource */
    domain: string;
    /** Human-readable name */
    name: string;
    /** Brief description or content snippet */
    description: string;
    /** Full content (optional — provider may omit for large results) */
    content?: string;
    /** Relevance score (provider-specific) */
    relevance?: number;
}

/**
 * Search options.
 */
export interface SearchOptions {
    /** Filter to a specific domain/skill */
    domain?: string;
    /** Maximum results to return */
    limit?: number;
    /** User scopes for access control filtering */
    scopes?: string[];
    /** Search mode hint (provider may ignore) */
    mode?: 'keyword' | 'semantic';
}

/**
 * Search provider interface.
 * Deployer implements this with their preferred search backend.
 *
 * @example
 * // Typesense implementation (in deployer code)
 * const search: SearchProvider = {
 *     async search(query, opts) {
 *         const results = await typesense.collections('resources').documents().search({
 *             q: query, query_by: 'content,name', filter_by: `domain:=${opts?.domain}`,
 *         });
 *         return results.hits.map(h => ({ uri: h.document.uri, ... }));
 *     },
 * };
 */
export interface SearchProvider {
    /**
     * Search across indexed resources.
     * Returns results ranked by relevance.
     */
    search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}
