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

/**
 * Thrown when a kind's policy requested `tools.native: 'sandboxed'`
 * but no `workdirRoot` was allocated (workspace-allocator absent /
 * mis-wired, or `cwd` not `workspace-workdir`). The sandbox PreToolUse
 * path-guard hooks cannot be installed, so confining native
 * Read/Write/Edit/Glob/Grep to a workdir is impossible.
 *
 * DOCTRINE: a restriction the engine can't enforce must FAIL CLOSED —
 * refuse, never silently grant. Mirrors `scope-check`'s
 * `ScopeEscalationError`: thrown from the `before` hook, caught by the
 * runner, surfaced to the caller as a refusal rather than letting the
 * agent step run native tools unsandboxed against the host FS.
 */
/** Annotation key for the fail-closed refusal marker. Mirrors the
 *  per-middleware annotation convention used by workspace-allocator /
 *  tool-surface-compose. A step handler reaching a non-throwing path
 *  can read this to refuse running with unsandboxed native tools. */
export const SANDBOX_REFUSAL_KEY = 'sandboxRequired';

/** Shape of the fail-closed refusal marker written to annotations. */
export interface SandboxRefusal {
    code: 'sandbox_unbindable';
    kindUri: string;
    reason: string;
}

export class SandboxBindError extends Error {
    readonly code = 'sandbox_unbindable';
    readonly kindUri: string;
    constructor(kindUri: string) {
        super(
            `kind "${kindUri}" requested sandboxed native tools (tools.native: 'sandboxed') ` +
                `but no workdirRoot was allocated — the sandbox PreToolUse path-guard hooks ` +
                `cannot be installed, so native Read/Write/Edit/Glob/Grep would run UNSANDBOXED ` +
                `against the host filesystem. Refusing (fail-closed).`,
        );
        this.name = 'SandboxBindError';
        this.kindUri = kindUri;
    }
}

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

export function sandboxBindMiddleware(opts: SandboxBindMiddlewareOpts): DispatchMiddleware {
    const annotationKey = opts.annotationKey ?? 'sandboxHooks';

    return {
        name: 'sandbox-bind',
        before(ctx: DispatchPreContext): DispatchPreContext {
            const policy = ctx.decl?.policy;
            const native = policy?.tools?.native;
            // Only bind when the kind opted into sandboxed native tools.
            if (native !== 'sandboxed') return ctx;
            // Workdir must be present — that's the workspace-allocator's
            // job. The kind's policy explicitly requested confinement
            // (native === 'sandboxed'); if no workdirRoot was allocated
            // we CANNOT install the PreToolUse path-guard hooks. Silently
            // returning here would let the agent step run native tools
            // entirely UNSANDBOXED against the host FS — a fail-OPEN.
            //
            // DOCTRINE: a restriction that cannot be honored must FAIL
            // CLOSED. We set the documented fail-closed marker (so any
            // step handler reached on a non-throwing path still refuses
            // to proceed with unsandboxed native tools) AND raise a typed
            // refusal — mirroring scope-check's `ScopeEscalationError`,
            // which the runner surfaces as an aborted/errored dispatch so
            // the agent step never runs unconfined against the host FS.
            if (!ctx.workdirRoot) {
                ctx.annotations[SANDBOX_REFUSAL_KEY] = {
                    code: 'sandbox_unbindable',
                    kindUri: ctx.decl?.uri ?? String(ctx.kind),
                    reason: 'sandboxed native tools requested but no workdirRoot allocated; refusing to run UNSANDBOXED',
                } satisfies SandboxRefusal;
                throw new SandboxBindError(ctx.decl?.uri ?? String(ctx.kind));
            }

            ctx.annotations[annotationKey] = opts.binder.build(ctx.workdirRoot, ctx);
            return ctx;
        },
    };
}
