/**
 * `sandboxBindMiddleware` — install PreToolUse hooks gating the
 * agent's native Read/Write/Edit/Glob/Grep to the workdir.
 *
 * Reads `kind.policy.tools.native`:
 *   - `'disallowed'` → no hooks installed; harness already rejects
 *     native tools per its disallowedTools allowlist
 *   - `'sandboxed'` → install hooks confining tools to the workdir
 *     allocated by `workspaceAllocatorMiddleware`
 *   - `'allowed'` → hooks NOT installed; agent has full filesystem
 *     access (rarely used; for migrate-tool style introspection
 *     across the repo)
 *
 * The actual hook implementation (path-security checks, traversal
 * rejection) is backend-specific and lives in the host application's
 * sandbox module. The lib provides the
 * middleware framework + the contract for what the backend supplies:
 * a `SandboxBinder` that takes the resolved `workdirRoot` and returns
 * hook descriptors the agent step handler injects via createOpts.
 *
 * The agent step handler reads `ctx.annotations.sandboxHooks` and
 * passes them to the harness's `createAgent({hooks})` option.
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';

/** Backend-supplied hook descriptor. The shape is intentionally
 *  loose — the lib doesn't depend on the Anthropic SDK's hook types.
 *  The agent step handler casts at the boundary. */
export type SandboxHooks = unknown;

export interface SandboxBinder {
    /** Build the hook descriptor set bound to a specific workdir. */
    build(workdirRoot: string, ctx: DispatchPreContext): SandboxHooks;
}

export interface SandboxBindMiddlewareOpts {
    binder: SandboxBinder;
    annotationKey?: string;
}

export function sandboxBindMiddleware(
    opts: SandboxBindMiddlewareOpts,
): DispatchMiddleware {
    const annotationKey = opts.annotationKey ?? 'sandboxHooks';

    return {
        name: 'sandbox-bind',
        before(ctx: DispatchPreContext): DispatchPreContext {
            const policy = ctx.decl?.policy;
            const native = policy?.tools?.native;
            // Only bind when the kind opted into sandboxed native tools.
            if (native !== 'sandboxed') return ctx;
            // Workdir must be present — that's the workspace-allocator's
            // job. If absent, the kind misconfigured the policy
            // (sandboxed without workspace-workdir); fail-fast at boot
            // when the workflow loads, OR pass through here and let
            // the handler error.
            if (!ctx.workdirRoot) return ctx;

            ctx.annotations[annotationKey] = opts.binder.build(
                ctx.workdirRoot,
                ctx,
            );
            return ctx;
        },
    };
}
