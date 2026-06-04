import picomatch from 'picomatch';

/**
 * Build a picomatch matcher with the same flag set we want everywhere
 * (bash-style: `*`, `**`, `?`, `[a-z]`, `{ts,tsx}`, leading `!` negation).
 * Setting `dot: true` so dotfiles match — that's what native Glob does.
 *
 * Shared by both the node (`node-adapters.ts`) and in-memory
 * (`in-memory-adapters.ts`) FsAdapters so prod / tests don't diverge.
 */
export function compileGlob(pattern: string): (p: string) => boolean {
    return picomatch(pattern, { dot: true });
}

/**
 * Resolve and validate the workdir-relative sub-path for glob/grep. We
 * forbid `..` segments lexically; we never `realpath` (symlink escapes are
 * blocked by the working-tree's hard-link layout, not by symlink resolution).
 */
export function safeSubpath(sub: string | undefined): string {
    if (!sub) return '';
    if (sub.startsWith('/') || sub.includes('\\')) {
        throw new Error('invalid_path');
    }
    if (sub.split('/').some(seg => seg === '..')) {
        throw new Error('parent_segment_not_allowed');
    }
    return sub.replace(/^\.\/+/, '').replace(/\/+$/, '');
}
