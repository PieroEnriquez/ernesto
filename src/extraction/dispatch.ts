/**
 * Extraction dispatch.
 *
 * Looks up by source, gates on scope, validates the fixed request shape, runs
 * the plugin's fetch, and shapes errors into a discriminated
 * `DispatchExtractionResult`. Plain TS validation here — `ExtractionRequest` is
 * a fixed shape with three fields, so wiring Zod adds no clarity over a few
 * `typeof` checks.
 */

import type { ExtractionRegistry } from './extraction-registry';
import type {
    ExtractionContext,
    ExtractionFormat,
    ExtractionPlugin,
    ExtractionRequest,
    ExtractionResult,
    ExtractionScope,
} from './define-extraction';

const AGENT_OPS_SCOPE: ExtractionScope = 'ernesto:agent-ops';

const ALLOWED_FORMATS: ReadonlySet<ExtractionFormat> = new Set<ExtractionFormat>([
    'markdown',
    'json',
    'text',
]);

export type DispatchExtractionErrorCode =
    | 'source_not_found'
    | 'scope_denied'
    | 'invalid_request'
    | 'fetch_failed';

export type DispatchExtractionResult =
    | { ok: true; data: ExtractionResult }
    | { ok: false; error: DispatchExtractionErrorCode; details?: unknown };

export async function dispatchExtraction(
    registry: ExtractionRegistry,
    source: string,
    request: ExtractionRequest,
    ctx: ExtractionContext,
): Promise<DispatchExtractionResult> {
    const plugin = registry.get(source);
    if (!plugin) {
        return { ok: false, error: 'source_not_found', details: { source } };
    }

    const scopeDenial = checkScope(plugin, ctx.scopes);
    if (scopeDenial) {
        return { ok: false, error: 'scope_denied', details: scopeDenial };
    }

    const requestError = validateRequest(request);
    if (requestError) {
        return { ok: false, error: 'invalid_request', details: requestError };
    }

    let raw: ExtractionResult;
    try {
        raw = await plugin.fetch(request, ctx);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'fetch_failed', details: { message } };
    }

    if (!isValidResult(raw)) {
        ctx.log.error('Extraction plugin returned malformed result', {
            source: plugin.source,
        });
        return {
            ok: false,
            error: 'fetch_failed',
            details: { message: 'plugin returned malformed result' },
        };
    }

    return { ok: true, data: raw };
}

interface ScopeDenialDetails {
    required: ReadonlyArray<ExtractionScope>;
    missing: ReadonlyArray<ExtractionScope>;
    missingCount: number;
}

function checkScope(
    plugin: ExtractionPlugin,
    scopes: ReadonlySet<ExtractionScope>,
): ScopeDenialDetails | null {
    if (scopes.has(AGENT_OPS_SCOPE)) return null;
    const missing = plugin.scope.filter((s) => !scopes.has(s));
    if (missing.length === 0) return null;
    return {
        required: plugin.scope,
        missing,
        missingCount: missing.length,
    };
}

function validateRequest(request: ExtractionRequest): { field: string; message: string } | null {
    if (typeof request.target !== 'string' || request.target.length === 0) {
        return { field: 'target', message: 'target must be a non-empty string' };
    }
    if (!ALLOWED_FORMATS.has(request.format)) {
        return { field: 'format', message: 'format must be markdown, json, or text' };
    }
    return null;
}

function isValidResult(raw: unknown): raw is ExtractionResult {
    if (!raw || typeof raw !== 'object') return false;
    const r = raw as { entries?: unknown; fetchedAt?: unknown };
    if (typeof r.fetchedAt !== 'string') return false;
    if (!Array.isArray(r.entries)) return false;
    for (const entry of r.entries) {
        if (!entry || typeof entry !== 'object') return false;
        const e = entry as { path?: unknown; content?: unknown; contentType?: unknown };
        if (typeof e.path !== 'string') return false;
        if (typeof e.content !== 'string') return false;
        if (typeof e.contentType !== 'string') return false;
    }
    return true;
}
