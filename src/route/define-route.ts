/**
 * Typed route definition.
 *
 * A `Route` is the lib's unit of executable, scope-gated action with Zod-typed
 * input and output. Routes self-register into a `RouteRegistry`; dispatch then
 * looks up by URI, validates, scope-checks, and runs the handler.
 *
 * Spec: `domains/workspaces/README.md` §30 (Route / defineRoute / RouteContext).
 * This module is the minimal scaffolding ahead of B.6 backend wiring; it omits
 * the full `RouteContext` shape from §30 (`principal`, `tier`, `ernesto`,
 * `workdirId`) because none of those values exist yet on the lib side. The
 * scaffolding context surfaces just what handlers can use today: `user`,
 * a live scope snapshot, an optional `workdirRoot`, and a logger.
 *
 * `user` matches the shape used by `ToolContext` (`skill.ts`) and `SessionUser`
 * (`Session.ts`) — `{ id, email? }`.
 */

import type { z } from 'zod';

export type RouteScope = string;

export interface RouteLogger {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
}

export interface RouteUser {
    id: string;
    email?: string;
}

export interface RouteContext {
    user: RouteUser;
    scopes: ReadonlySet<RouteScope>;
    /** Path to the on-disk working tree when invoked inside a workdir. Absent
     *  for direct HTTP/dispatch paths that do not yet have a workdir bound
     *  (e.g. early Tier B `tools/call` before workdir resolution, or unit
     *  tests). Handlers that require it must assert and surface a clear
     *  error — there is no implicit fallback. */
    workdirRoot?: string;
    log: RouteLogger;
}

export interface RouteConfig<
    I extends z.ZodTypeAny,
    O extends z.ZodTypeAny,
> {
    uri: string;
    scope: RouteScope | ReadonlyArray<RouteScope>;
    input: I;
    output: O;
    description?: string;
    handler: (input: z.infer<I>, ctx: RouteContext) => Promise<z.infer<O>>;
}

export interface Route<
    I extends z.ZodTypeAny = z.ZodTypeAny,
    O extends z.ZodTypeAny = z.ZodTypeAny,
> {
    readonly uri: string;
    readonly scope: ReadonlyArray<RouteScope>;
    readonly input: I;
    readonly output: O;
    readonly description?: string;
    readonly handler: (input: z.infer<I>, ctx: RouteContext) => Promise<z.infer<O>>;
}

export function defineRoute<
    I extends z.ZodTypeAny,
    O extends z.ZodTypeAny,
>(config: RouteConfig<I, O>): Route<I, O> {
    const scope = Array.isArray(config.scope)
        ? Object.freeze([...config.scope])
        : Object.freeze([config.scope as RouteScope]);
    return Object.freeze({
        uri: config.uri,
        scope,
        input: config.input,
        output: config.output,
        description: config.description,
        handler: config.handler,
    });
}
