/**
 * Compactify a route response for inline preview in a tool_result.
 *
 * The agent sees this `preview` shape *plus* a `file` pointer to the
 * full archived JSON. Goal: enough structure for a follow-up question
 * ("what's the row with the highest margin?") to be answerable without
 * re-querying, while keeping the inline cost bounded.
 *
 * Rules:
 *  - scalar (string / number / boolean / null) passes through.
 *  - array becomes `{ total, limit, items }` so a downstream reader
 *    always knows the real size without scrolling the limited items.
 *  - object recurses on each value (arrays-as-fields get wrapped too).
 *  - max depth 4 — defends against pathological deeply-nested input.
 *
 * Pure function; no I/O, no logging.
 */

const MAX_DEPTH = 4;

export interface CompactArrayWrapper {
    total: number;
    limit: number;
    items: unknown[];
}

export function compactify(data: unknown, limit: number): unknown {
    return walk(data, limit, 0);
}

function walk(value: unknown, limit: number, depth: number): unknown {
    // Scalars (incl. null) — passthrough.
    if (value === null) return null;
    const t = typeof value;
    if (t === 'string' || t === 'number' || t === 'boolean') return value;
    // Anything else past the depth cap collapses to a typed marker so
    // the agent still sees that there was *something* there.
    if (depth >= MAX_DEPTH) {
        if (Array.isArray(value)) {
            return { total: value.length, limit, items: [] };
        }
        if (t === 'object') return {};
        return null;
    }
    if (Array.isArray(value)) {
        const safeLimit = Math.max(0, limit);
        const sliced = value.slice(0, safeLimit);
        return {
            total: value.length,
            limit: safeLimit,
            items: sliced.map((item) => walk(item, limit, depth + 1)),
        } satisfies CompactArrayWrapper;
    }
    if (t === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = walk(v, limit, depth + 1);
        }
        return out;
    }
    // Functions, symbols, undefined — drop to null for JSON-safety.
    return null;
}
