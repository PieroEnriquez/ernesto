/**
 * `workspaceAllocatorMiddleware` — allocate a per-conversation workdir
 * for kinds declaring `policy.cwd === 'workspace-workdir'`.
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
 * The middleware reads `kind.policy.cwd`, calls `allocate`, stashes
 * `workdirRoot` on the ctx (consumed by step handlers via
 * `ctx.workdirRoot`), and calls `release()` in the `after` hook.
 *
 * Persistent sessions (workspace-tier with `policy.sessionContinuity:
 * 'persistent'`) skip the release on terminal — the workdir is reused
 * across conversation turns. The session lifecycle manages its own
 * teardown.
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';
import type { Run } from '../types/runner';

/** Backend-supplied allocator. Implementation lives in
 *  `src/ernesto/domains/workspaces/tier-a/open-managed-workdir.ts`. */
export interface WorkspaceAllocator {
    /** Allocate a workdir for this dispatch. May reuse an existing
     *  one if `ctx.opts.conversationKey` matches a live session. */
    allocate(ctx: DispatchPreContext): Promise<WorkspaceAllocation>;
}

export interface WorkspaceAllocation {
    /** Absolute path to the workdir. The walker sets it on step
     *  ctx.workdirRoot. */
    workdirRoot: string;
    /** Optional release function. Called on terminal unless the
     *  policy declares persistent session continuity. */
    release?: () => Promise<void> | void;
    /** Opaque handle the backend may use to identify the workdir
     *  (e.g. session id, BullMQ job correlator). */
    handle?: unknown;
}

export interface WorkspaceAllocatorMiddlewareOpts {
    allocate: WorkspaceAllocator['allocate'];
    /** Annotation key the middleware uses to stash the allocation
     *  for the after-hook. Override only for collision avoidance. */
    annotationKey?: string;
}

export function workspaceAllocatorMiddleware(
    opts: WorkspaceAllocatorMiddlewareOpts,
): DispatchMiddleware {
    const annotationKey = opts.annotationKey ?? '__workspaceAllocation';

    return {
        name: 'workspace-allocator',
        async before(ctx: DispatchPreContext): Promise<DispatchPreContext> {
            const cwd = ctx.decl?.policy?.cwd;
            if (cwd !== 'workspace-workdir') return ctx;

            const allocation = await opts.allocate(ctx);
            ctx.workdirRoot = allocation.workdirRoot;
            ctx.annotations[annotationKey] = allocation;
            return ctx;
        },
        async after(ctx: DispatchPreContext, _run: Run): Promise<void> {
            const allocation = ctx.annotations[annotationKey] as
                | WorkspaceAllocation
                | undefined;
            if (!allocation) return;
            // Persistent sessions retain the workdir across runs.
            const sessionContinuity = ctx.decl?.policy?.sessionContinuity;
            if (sessionContinuity === 'persistent') return;
            if (allocation.release) {
                await allocation.release();
            }
        },
    };
}
