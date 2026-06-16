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

import type { Logger, Principal } from '../shared/types';

export type ExtractionScope = string;

export interface ExtractionContext {
    user: Principal;
    scopes: ReadonlySet<ExtractionScope>;
    log: Logger;
}

export interface ExtractionRequest {
    target: string;
    refresh?: boolean;
    /**
     * Optional case-insensitive substring filters applied to the path of each
     * produced entry. `includePaths` is allow-list semantics (entry survives
     * iff at least one substring matches); `excludePaths` is deny-list semantics
     * (entry is dropped iff at least one substring matches), applied after
     * `includePaths`. Plugins that walk multiple resources interpret these;
     * plugins targeting a single resource may ignore them.
     */
    includePaths?: ReadonlyArray<string>;
    excludePaths?: ReadonlyArray<string>;
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
    const scope = Array.isArray(config.scope) ? Object.freeze([...config.scope]) : Object.freeze([config.scope as ExtractionScope]);
    return Object.freeze({
        source: config.source,
        scope,
        description: config.description,
        fetch: config.fetch,
    });
}
