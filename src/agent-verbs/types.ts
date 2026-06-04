/**
 * Shared agent-verb types.
 *
 * The verbs (`execute`, `settle`) are the transport-uniform agent-facing
 * surface (same shape across in-process / mcp / laptop). The lib owns
 * input/output schemas + verb handlers; transport frontends
 * register them as the appropriate transport (SDK custom tool, MCP tool,
 * HTTPS endpoint) and inject side-effect implementations via `hooks`.
 */

import type { Logger, Principal } from '../shared/types';

/** @deprecated alias for the unified {@link Logger}. */
export type VerbLogger = Logger;

/** @deprecated alias for the unified {@link Principal}. */
export type VerbUser = Principal;
