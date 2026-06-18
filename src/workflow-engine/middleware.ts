/**
 * DispatchMiddleware — ordered hooks around every `dispatch(...)`.
 *
 * The substrate's promise is "one dispatch, many policies." Policy
 * effects (scope check, workspace allocation, sandbox bind, tool-
 * surface composition, model routing, idempotency dedup, event-log
 * init) are expressed as ordered middleware that read the kind's
 * declared `KindPolicy` and act accordingly.
 *
 * Lifecycle per dispatch:
 *   1. `before(ctx)` runs for each middleware in registration order;
 *      can transform the ctx (set workdirRoot, narrow principal,
 *      attach MCP factory) or short-circuit by throwing.
 *   2. The runner's walker executes the workflow.
 *   3. `after(ctx, result)` runs in REVERSE order (post-order) for
 *      each middleware; can read the terminal result, write
 *      projections, release resources.
 *
 * Middleware are registered via `runner.use(middleware)`. There is no
 * de-registration — the chain is set at boot and stable across
 * dispatches. Tests use a fresh runner.
 *
 * See workspaces/agent-ops/unified-runtime/architecture.md §"The
 * 17-step middleware chain".
 */

import type { Principal } from './principal';
import type { DispatchOpts, KindRef, Run } from './types/runner';
import type { KindDecl } from './kind-registry';
import type { WorkspaceView } from '../route/define-route';

/** Mutable per-dispatch context the middleware chain reads/writes. */
export interface DispatchPreContext {
    kind: KindRef;
    inputs: Record<string, unknown>;
    principal: Principal;
    opts: DispatchOpts;
    /** Runner-minted runId for this dispatch. Available before any
     *  middleware runs so durable-claim middleware
     *  (`eventLogInitMiddleware`) can write a row keyed by it
     *  pre-walk, and so any middleware can reference the run by id. */
    runId: string;
    /** Resolved by the runner before invoking middleware. Middleware
     *  read `decl.policy` to decide whether to act. */
    decl?: KindDecl;
    /** Workdir root — middleware (workspace-allocator) sets this. */
    workdirRoot?: string;
    /** Bound overlay-backed view (Wave 0, parallel to workdirRoot). Set by the
     *  transport/composer via `opts.context.workspaceView` and threaded onto the
     *  walker/handler ctx. Optional/additive. */
    workspaceView?: WorkspaceView;
    /** Conversation-scope id — the tool-surface-compose middleware
     *  sets/reuses this. Keyed by `conversationKey` for persistent
     *  conversations, else the run id. Scopes the composed MCP
     *  surfaces; NOT the SDK transcript id. */
    conversationId?: string;
    /** Free-form per-middleware annotations — extension point for
     *  middleware to communicate with later middleware in the chain
     *  without polluting the public DispatchOpts surface. */
    annotations: Record<string, unknown>;
}

/** A middleware ships a `name`, optional `before`, optional `after`,
 *  or both. */
export interface DispatchMiddleware {
    /** Identifier for debugging + observability. Should be unique
     *  across the chain. */
    name: string;
    /** Pre-dispatch hook. Runs in registration order. May transform
     *  ctx or throw to abort dispatch. Returning the same ctx object
     *  is fine — mutate in place or return a fresh one. */
    before?(ctx: DispatchPreContext): Promise<DispatchPreContext> | DispatchPreContext;
    /** Post-dispatch hook. Runs in REVERSE order (LIFO) so resource
     *  acquisition + release nest correctly. Errors here are logged
     *  but don't override the dispatch result. */
    after?(ctx: DispatchPreContext, run: Run): Promise<void> | void;
}

/** Run the middleware chain's `before` hooks, in registration order.
 *  Returns the final transformed ctx. Errors in `before` propagate —
 *  the caller catches and rejects the dispatch. */
export async function runBefore(middlewares: ReadonlyArray<DispatchMiddleware>, ctx: DispatchPreContext): Promise<DispatchPreContext> {
    let cur = ctx;
    for (const mw of middlewares) {
        if (!mw.before) continue;
        cur = await mw.before(cur);
    }
    return cur;
}

/** Run the middleware chain's `after` hooks in REVERSE order (LIFO).
 *  Errors are caught + logged via `errorSink` so resource cleanup
 *  always completes even if one middleware throws. */
export async function runAfter(
    middlewares: ReadonlyArray<DispatchMiddleware>,
    ctx: DispatchPreContext,
    run: Run,
    errorSink?: (mw: DispatchMiddleware, err: unknown) => void,
): Promise<void> {
    for (let i = middlewares.length - 1; i >= 0; i--) {
        const mw = middlewares[i]!;
        if (!mw.after) continue;
        try {
            await mw.after(ctx, run);
        } catch (err) {
            if (errorSink) errorSink(mw, err);
        }
    }
}

/** Build a fresh DispatchPreContext snapshot. Used by the runner at
 *  the top of every dispatch.
 *
 *  A child dispatch issued from an agent step's tool surface carries the
 *  parent's bound `workspaceView` (and, for the eager-projection routes, its
 *  `workdirRoot`) on `opts.context` — the tool-surface composer threads them
 *  there. Seed them onto the precontext up front so they reach the walker even
 *  for `physicalTree: 'lazy'` route kinds the workspace allocator skips. The
 *  allocator's `before` hook runs afterward and overwrites `workdirRoot` when
 *  it allocates an eager workdir; the seeded view is never clobbered (no
 *  middleware writes it). This is the lib-native replacement for the backend's
 *  former `inheritWorkdirRootMiddleware`. */
export function buildPreContext(
    kind: KindRef,
    inputs: Record<string, unknown>,
    principal: Principal,
    opts: DispatchOpts,
    runId: string,
): DispatchPreContext {
    const inheritedView = opts.context?.workspaceView as WorkspaceView | undefined;
    const inheritedWorkdirRoot = opts.context?.workdirRoot;
    return {
        kind,
        inputs,
        principal,
        opts,
        runId,
        annotations: {},
        ...(inheritedView !== undefined ? { workspaceView: inheritedView } : {}),
        ...(typeof inheritedWorkdirRoot === 'string' && inheritedWorkdirRoot.length > 0
            ? { workdirRoot: inheritedWorkdirRoot }
            : {}),
    };
}
