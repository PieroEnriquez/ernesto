/**
 * Typed extraction plugin definition.
 *
 * An `ExtractionPlugin` is the lib's unit of source-specific content fetching
 * for workspaces. Plugins self-register into an `ExtractionRegistry`; the
 * extraction worker then walks each workspace's `extractions:` frontmatter and
 * dispatches by `source`, writing results to `master-fs/workspaces/{w}/extracted/`.
 *
 * Spec: `domains/workspaces/README.md` §F (extractions / extracted/).
 * This module is the lib substrate ahead of worker wiring; it omits the
 * `workdirRoot` field present on `RouteContext` because extractions write to
 * master-fs, not to per-turn workdirs.
 *
 * `user` matches the shape used by `RouteContext` and `ToolContext` —
 * `{ id, email? }`.
 */

export type ExtractionScope = string;

export interface ExtractionLogger {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
}

export interface ExtractionUser {
    id: string;
    email?: string;
}

export interface ExtractionContext {
    user: ExtractionUser;
    scopes: ReadonlySet<ExtractionScope>;
    log: ExtractionLogger;
}

export interface ExtractionRequest {
    target: string;
    refresh?: boolean;
}

export interface ExtractionEntry {
    path: string;
    content: string;
    contentType: string;
    etag?: string;
}

export interface ExtractionResult {
    entries: ReadonlyArray<ExtractionEntry>;
    fetchedAt: string;
}

export interface ExtractionPluginConfig {
    source: string;
    scope: ExtractionScope | ReadonlyArray<ExtractionScope>;
    description?: string;
    fetch: (req: ExtractionRequest, ctx: ExtractionContext) => Promise<ExtractionResult>;
}

export interface ExtractionPlugin {
    readonly source: string;
    readonly scope: ReadonlyArray<ExtractionScope>;
    readonly description?: string;
    readonly fetch: ExtractionPluginConfig['fetch'];
}

export function defineExtraction(config: ExtractionPluginConfig): ExtractionPlugin {
    const scope = Array.isArray(config.scope)
        ? Object.freeze([...config.scope])
        : Object.freeze([config.scope as ExtractionScope]);
    return Object.freeze({
        source: config.source,
        scope,
        description: config.description,
        fetch: config.fetch,
    });
}
