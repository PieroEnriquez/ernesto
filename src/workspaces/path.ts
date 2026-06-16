/**
 * Tree-relative path hygiene — the one validator every workspace path entering
 * the system passes through. A clean tree-relative path has no leading slash,
 * no NUL, no backslash, and no traversal/empty segment (`..`, `.`, ``). This
 * kernel was duplicated across the backend's path-handling surfaces; it lives
 * here so they all reject the same shapes.
 */

const MAX_PATH_BYTES = 4096;

/**
 * Validate a raw tree-relative path. Returns the path unchanged when it is
 * clean, or `null` when it is rejected. Rejects: non-strings, length over
 * {@link MAX_PATH_BYTES}, a leading slash, a NUL char, a backslash, and any
 * segment equal to `..`, `.`, or empty.
 */
export function validateTreeRelPath(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    if (raw.length > MAX_PATH_BYTES) return null;
    if (raw.startsWith('/')) return null;
    if (raw.includes('\0')) return null;
    if (raw.includes('\\')) return null;
    for (const seg of raw.split('/')) {
        if (seg === '..' || seg === '.' || seg === '') return null;
    }
    return raw;
}
