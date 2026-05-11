/**
 * Shared agent-verb types.
 *
 * The verbs (`execute`, `settle`) are the Tier-A/B/C-uniform agent-facing
 * surface. The lib owns input/output schemas + verb handlers; tier frontends
 * register them as the appropriate transport (SDK custom tool, MCP tool,
 * HTTPS endpoint) and inject side-effect implementations via `hooks`.
 */

export interface VerbLogger {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
}

export interface VerbUser {
    id: string;
    email?: string;
}
