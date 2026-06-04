/**
 * Path-security primitives. Pure lexical operations on path strings — no
 * symlink following, no filesystem I/O.
 *
 * These are used at security boundaries (the in-process transport's Agent
 * SDK PreToolUse hooks, the mcp transport's tool handlers, the laptop
 * transport's sandbox) to keep file access inside per-workdir /
 * per-workspace boundaries.
 *
 * Why no `realpathSync`?
 *
 *   We *want* path checks to stay anchored to the lexical path the agent
 *   passed — not its symlink target. The system places workspace-overlay
 *   symlinks at `workspaces/{w}/{extracted,attached}/` that point into the
 *   shared master-fs pool. If `isPathWithin` followed symlinks, every
 *   workspace-scoped path under those overlays would resolve to a master-fs
 *   absolute, blowing through the workspace boundary.
 *
 *   `containsParentSegment` closes the corollary: even with lexical
 *   checks, `workspaces/hr/extracted/../../cs/extracted/secret.md` would,
 *   when opened by Node's `fs`, follow the `extracted` symlink and the
 *   `..` would land in master-fs/workspaces, crossing the workspace
 *   boundary. We deny any path containing a `..` segment upfront.
 */

import { resolve, sep } from 'path';

/**
 * Resolve a path to an absolute, lexically-normalized form **without
 * following any symlinks**.
 *
 * macOS quirk: `tmpdir()` returns `/var/folders/...` but the realpath is
 * `/private/var/folders/...` (because `/var` is a symlink to
 * `/private/var`). Trusted allowlist init paths are normalized to the
 * `/private/var` form via {@link resolveAllowedDir}; untrusted agent input
 * is normalized here. We textually prepend `/private` so both sides match
 * without invoking `realpathSync` on the agent's path.
 */
export function resolvePath(filePath: string): string {
    const resolved = resolve(filePath);
    if (resolved === '/var' || resolved.startsWith('/var/')) {
        return '/private' + resolved;
    }
    return resolved;
}

/**
 * Like {@link resolvePath} but for trusted allowed-directory init: we DO
 * follow symlinks here so the allowlist is canonical (handles
 * `/var` → `/private/var` and any other host-side filesystem layout
 * quirks). Call this **once at setup time** for each allowed dir — never
 * on agent input.
 *
 * Pass a `realpath` function (typically `realpathSync` from `node:fs`).
 * The lib does not import from `fs` itself so it can run in non-Node
 * environments where appropriate; pass `null` to skip the canonicalization.
 */
export function resolveAllowedDir(
    filePath: string,
    realpath: ((p: string) => string) | null,
): string {
    if (realpath === null) return resolvePath(filePath);
    try {
        return realpath(resolve(filePath));
    } catch {
        return resolvePath(filePath);
    }
}

/**
 * True when `filePath` is `allowedDir` itself or any descendant. Compares
 * lexically; both sides should have been run through {@link resolvePath}
 * or {@link resolveAllowedDir} first.
 */
export function isPathWithin(filePath: string, allowedDir: string): boolean {
    const resolved = resolvePath(filePath);
    return resolved === allowedDir || resolved.startsWith(allowedDir + sep);
}

/**
 * True if the input path contains a `..` segment (raw, before resolution).
 * Used as a defense-in-depth alongside {@link isPathWithin} — see the file
 * header for why.
 */
export function containsParentSegment(filePath: string): boolean {
    return filePath.split(/[\/\\]/).some((seg) => seg === '..');
}
