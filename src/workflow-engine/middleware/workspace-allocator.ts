/**
 * `workspaceAllocatorMiddleware` — allocate a per-conversation workdir
 * for kinds declaring `policy.physicalTree === 'eager'`.
 *
 * Filesystem operations (`hardlink master-fs into workdir`,
 * `materialize sparse files on Read`, etc.) are backend-specific and
 * not in the lib. The lib provides the middleware shell + the
 * contract for what the backend supplies: a `WorkspaceAllocator`
 * function pair.
 *
 * Backend wires:
 *
 *   runner.use(workspaceAllocatorMiddleware({
 *       allocate: async (ctx) => {
 *           const workdir = await openManagedWorkdir({
 *               conversationKey: ctx.opts.conversationKey,
 *               workspace: ctx.decl?.policy?.workspace,
 *               userId: ctx.principal.kind === 'user'
 *                   ? ctx.principal.userId
 *                   : ctx.principal.workerId,
 *           });
 *           return { workdirRoot: workdir.path, release: () => closeWorkdir(workdir) };
 *       },
 *   }));
 *
 * The middleware reads `kind.policy.physicalTree`, calls `allocate`, stashes
 * `workdirRoot` on the ctx (consumed by step handlers via
 * `ctx.workdirRoot`), and calls `release()` in the `after` hook.
 *
 * Persistent conversations (`policy.continuity: 'persistent'`) skip
 * the release on terminal — the workdir is reused across conversation
 * turns. The backend's per-user handle manages its own teardown.
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';
import type { Run } from '../types/runner';

/** Backend-supplied allocator. Implementation lives in the host
 *  application's in-process workdir module. */
export interface WorkspaceAllocator {
    /** Allocate a workdir for this dispatch. May reuse an existing
     *  one if `ctx.opts.conversationKey` matches a live conversation. */
    allocate(ctx: DispatchPreContext): Promise<WorkspaceAllocation>;
}

export interface WorkspaceAllocation {
    /** Absolute path to the workdir. The walker sets it on step
     *  ctx.workdirRoot. */
    workdirRoot: string;
    /** Optional release function. Called on terminal unless the
     *  policy declares persistent continuity. */
    release?: () => Promise<void> | void;
    /** Opaque handle the backend may use to identify the workdir
     *  (e.g. workdir id, BullMQ job correlator). */
    handle?: unknown;
}

export interface WorkspaceAllocatorMiddlewareOpts {
    allocate: WorkspaceAllocator['allocate'];
    /** Annotation key the middleware uses to stash the allocation
     *  for the after-hook. Override only for collision avoidance. */
    annotationKey?: string;
}

export function workspaceAllocatorMiddleware(opts: WorkspaceAllocatorMiddlewareOpts): DispatchMiddleware {
    const annotationKey = opts.annotationKey ?? '__workspaceAllocation';

    return {
        name: 'workspace-allocator',
        async before(ctx: DispatchPreContext): Promise<DispatchPreContext> {
            // Eager physical-tree intent: allocate (or reuse) a real on-disk
            // workdir up front. `lazy` kinds project from the bound
            // `workspaceView` on demand and never allocate here.
            if (ctx.decl?.policy?.physicalTree !== 'eager') return ctx;

            // A ROUTE kind invoked as a child of an agent operates on the
            // PARENT agent's workdir, which the parent threads down via
            // `opts.context.workdirRoot` (the backend tool-surface composer).
            // `buildPreContext` already seeded `ctx.workdirRoot` from it, so an
            // eager route reached through a child dispatch — e.g.
            // `code://materialize`, which hard-links bytes INTO the caller's
            // workdir for the agent to Read back — REUSES that workdir rather
            // than allocating a fresh throwaway one the agent can't see.
            // Workflow/agent kinds always get their own workdir (subagent
            // isolation), so this reuse is route-only.
            if (ctx.decl?.kind === 'route' && typeof ctx.workdirRoot === 'string' && ctx.workdirRoot.length > 0) {
                return ctx;
            }

            const allocation = await opts.allocate(ctx);
            ctx.workdirRoot = allocation.workdirRoot;
            ctx.annotations[annotationKey] = allocation;
            return ctx;
        },
        async after(ctx: DispatchPreContext, _run: Run): Promise<void> {
            const allocation = ctx.annotations[annotationKey] as WorkspaceAllocation | undefined;
            if (!allocation) return;
            // Persistent conversations retain the workdir across runs.
            const continuity = ctx.decl?.policy?.continuity;
            if (continuity === 'persistent') return;
            if (allocation.release) {
                await allocation.release();
            }
        },
    };
}
