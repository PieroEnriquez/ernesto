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
    ExtractionPlugin,
    ExtractionRequest,
    ExtractionResult,
    ExtractionScope,
} from './define-extraction';
import { checkScope } from '../shared/scope';

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

    const scopeDenial = checkScope(plugin.scope, ctx.scopes);
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

function validateRequest(request: ExtractionRequest): { field: string; message: string } | null {
    if (typeof request.target !== 'string' || request.target.length === 0) {
        return { field: 'target', message: 'target must be a non-empty string' };
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
