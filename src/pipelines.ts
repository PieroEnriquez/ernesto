/**
 * Content Extraction Pipeline - Composition of Source + Formats
 */

import { ContentSource, ContentFormat, PipelineConfig, RawDocument, DEFAULT_CACHE_TTL_MS, ResourceNode } from './types';
import debug from 'debug';

const log = debug('pipelines');

/**
 * Generate a deterministic source ID from pipeline configuration
 * Used to track which source produced documents in Typesense
 */
export function generateSourceId(sourceName: string, basePath: string): string {
    // Normalize: lowercase, remove special chars, join with underscore
    const normalizedSource = sourceName.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const normalizedPath = (basePath || 'root').toLowerCase().replace(/[^a-z0-9]/g, '_');
    return `${normalizedSource}__${normalizedPath}`;
}

export class ContentPipeline {
    private readonly source: ContentSource;
    private readonly formats: ContentFormat[];
    private readonly basePath: string;
    private readonly cacheTtlMs: number;

    /** Unique identifier for this source, used for per-source freshness tracking */
    public readonly sourceId: string;

    constructor(config: PipelineConfig) {
        this.source = config.source;
        this.formats = config.formats;
        this.basePath = config.basePath || '';
        this.cacheTtlMs = config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        this.sourceId = generateSourceId(config.source.name, this.basePath);

        if (this.formats.length === 0) {
            throw new Error('ContentPipeline requires at least one format adapter');
        }
    }

    /**
     * Fetch all resources from the pipeline
     * This is the main entry point - compose source + formats
     */
    async fetchResources(): Promise<ResourceNode[]> {
        try {
            // Step 1: List all documents from source
            const documents = await this.source.listDocuments();

            if (documents.length === 0) {
                log('No documents found', {
                    source: this.source.name,
                });
                return [];
            }

            // Step 2: Process each document
            const allResources: ResourceNode[] = [];

            for (const doc of documents) {
                try {
                    const resources = await this.processDocument(doc);
                    allResources.push(...resources);
                } catch (error) {
                    log('Failed to process document', {
                        docId: doc.id,
                        docName: doc.name,
                        source: this.source.name,
                        error,
                    });
                    // Continue processing other documents
                }
            }

            return allResources;
        } catch (error) {
            log('Fetch failed', {
                source: this.source.name,
                error,
            });
            throw new Error(`ContentPipeline failed: ${error}`);
        }
    }

    /**
     * Process a single document through the format pipeline
     */
    private async processDocument(doc: RawDocument): Promise<ResourceNode[]> {
        const format = this.findFormat(doc.contentType);

        if (!format) {
            log('No format handler found', {
                docId: doc.id,
                contentType: doc.contentType,
                availableFormats: this.formats.map((f) => f.name),
            });
            return [];
        }

        const content = await this.source.fetchContent(doc.id);

        const docBasePath = this.buildDocumentPath(doc);
        const resources = await format.parse(content, docBasePath);

        return resources;
    }

    /**
     * Find format adapter that can handle the content type
     * Returns first matching format (order matters)
     */
    private findFormat(contentType: string): ContentFormat | null {
        for (const format of this.formats) {
            if (format.canHandle(contentType)) {
                return format;
            }
        }
        return null;
    }

    /**
     * Build full path for a document
     * Combines basePath + document path
     */
    private buildDocumentPath(doc: RawDocument): string {
        // Remove leading slash from doc.path to avoid double slashes
        const docPath = doc.path.startsWith('/') ? doc.path.slice(1) : doc.path;

        if (!this.basePath) {
            // If docPath is empty, return empty string (no wrapper)
            // Otherwise return /docPath
            return docPath ? `/${docPath}` : '';
        }

        const base = this.basePath.startsWith('/') ? this.basePath : `/${this.basePath}`;
        return docPath ? `${base}/${docPath}` : base;
    }

    /**
     * Get pipeline configuration summary
     * Useful for debugging and logging
     */
    getSummary(): {
        source: string;
        sourceId: string;
        formats: string[];
        basePath: string;
        cacheTtlMs: number;
    } {
        return {
            source: this.source.name,
            sourceId: this.sourceId,
            formats: this.formats.map((f) => f.name),
            basePath: this.basePath,
            cacheTtlMs: this.cacheTtlMs,
        };
    }
}
