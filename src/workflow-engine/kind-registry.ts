/**
 * KindRegistry — the unified by-URI registry for everything
 * dispatchable.
 *
 * The substrate's promise is "one dispatch, many kinds." This class is
 * where every URI lands: route URIs (`marketing://cohorts`,
 * `payments://method-detail`), workflow slugs
 * (`product-enablement://pipeline`), managed-agent refs
 * (`workspace://agent-slug`), dashboard specs
 * (`marketing://acquisition-cohorts`).
 *
 * Two discriminated variants today:
 *   - `route` — wraps a `Route` (typed handler, input/output schemas,
 *     scope). Route kinds are programmatic — registered by backend
 *     modules at boot.
 *   - `workflow` — wraps a `WorkflowDeclaration`. Workflow kinds can
 *     be programmatic OR loaded declaratively from
 *     `workspaces/<w>/{workflows,managed-agents,dashboards}/`.
 *
 * Both carry an optional `KindPolicy` that middleware reads to decide
 * whether to allocate a workdir, install sandbox hooks, build per-run
 * MCP servers, route models, enforce idempotency, etc.
 *
 * See workspaces/agent-ops/unified-runtime/architecture.md for the
 * full policy model.
 */

import type { Route } from '../route/define-route';
import type { WorkflowDeclaration } from '../workflows/types';

/** Cross-cutting policy a kind declares — read by middleware. */
export interface KindPolicy {
    /** Where this kind expects its workdir:
     *  - `workspace-workdir` → workspace-allocator middleware allocates
     *    a per-conversation workdir, hardlinks master-fs in.
     *  - `ephemeral` → middleware allocates a temp dir scoped to the
     *    run; cleaned up on terminal.
     *  - `none` → no cwd (route handlers, expression kinds). */
    cwd?: 'workspace-workdir' | 'ephemeral' | 'none';
    /** Workspace identifier — used by the allocator middleware when
     *  `cwd === 'workspace-workdir'`. Falls back to the workspace
     *  prefix of the kind URI when absent. */
    workspace?: string;
    /** Tool policy for the harness:
     *  - `allowed[]` — explicit allowlist; absent means default
     *  - `disallowed[]` — denylist; complements allowed
     *  - `native` — whether SDK's Read/Write/Edit/Glob/Grep/Bash are
     *    allowed (workspace-tier) or disallowed (server-tier MCP-only). */
    tools?: {
        allowed?: string[];
        disallowed?: string[];
        native?: 'allowed' | 'sandboxed' | 'disallowed';
    };
    /** HITL availability — service principals never HITL regardless. */
    hitl?: 'never' | 'available-if-user' | 'required';
    /** Session reuse semantics. */
    sessionContinuity?: 'ephemeral' | 'persistent';
    /** Idempotency — middleware consults the event log for prior
     *  in-flight or completed runs keyed by this expression. */
    idempotent?: {
        key: string;
        scope: 'per-key' | 'per-key-and-principal';
        rerunAfter?: string;
    };
    /** Dispatch timeout cap. */
    timeoutMs?: number;
    /** Retry on failure — middleware re-dispatches up to `max` times. */
    retry?: { max: number; backoffMs?: number; on?: 'any' | 'transient' };
    /** Model + provider — model-router middleware sets SDK env from
     *  these. Only meaningful for agent kinds. */
    model?: string;
    provider?: 'ANTHROPIC' | 'OPEN_ROUTER';
    /** Render manifest hint — see route/render.ts RenderEntry. */
    render?: ReadonlyArray<unknown>;
}

/** A unified kind declaration. Discriminator `kind` identifies which
 *  shape the runtime dispatches through. */
export type KindDecl =
    | { kind: 'route'; uri: string; route: Route; policy?: KindPolicy }
    | {
          kind: 'workflow';
          uri: string;
          declaration: WorkflowDeclaration;
          policy?: KindPolicy;
      };

/**
 * One registry, one lookup, one dispatch path. Routes and workflows
 * coexist by URI; the discriminator on `KindDecl.kind` tells the
 * dispatcher which handler shape to use.
 *
 * Duplicate URIs throw at registration time — a programming error,
 * not a runtime fallback. The lib's `RouteRegistry` and the
 * `WorkflowReader` continue to exist but the substrate's preferred
 * resolution path is through here.
 */
export class KindRegistry {
    private readonly byUri = new Map<string, KindDecl>();

    register(decl: KindDecl): void {
        if (this.byUri.has(decl.uri)) {
            throw new Error(`KindRegistry: duplicate URI: ${decl.uri}`);
        }
        this.byUri.set(decl.uri, decl);
    }

    /** Convenience: register a route kind. The policy defaults to
     *  `{ cwd: 'none', tools: { native: 'disallowed' }, hitl: 'never' }`
     *  — the natural shape for server-tier MCP-only route handlers. */
    registerRoute(route: Route, policy?: KindPolicy): void {
        this.register({
            kind: 'route',
            uri: route.uri,
            route,
            ...(policy ? { policy } : {}),
        });
    }

    /** Convenience: register a workflow kind. Policy is read from the
     *  declaration's frontmatter today; the caller can override.
     *
     *  Safe default: when the main step is `kind: 'agent'` and the
     *  caller didn't pin `policy.cwd`, default to `'workspace-workdir'`.
     *  Agent steps without a sandboxed workdir would let the SDK's
     *  native Read/Write/Edit/Glob/Grep escape to the process CWD with
     *  no path-guard — never the intent. Callers that explicitly want
     *  `cwd: 'none'` for an agent step have to set it themselves and
     *  accept the risk. */
    registerWorkflow(
        declaration: WorkflowDeclaration,
        policy?: KindPolicy,
    ): void {
        const merged = mergeWorkflowPolicyDefaults(declaration, policy);
        this.register({
            kind: 'workflow',
            uri: declaration.name,
            declaration,
            ...(merged ? { policy: merged } : {}),
        });
    }

    resolve(uri: string): KindDecl | undefined {
        return this.byUri.get(uri);
    }

    has(uri: string): boolean {
        return this.byUri.has(uri);
    }

    list(filter?: { kind?: 'route' | 'workflow'; workspace?: string }): KindDecl[] {
        let out = [...this.byUri.values()];
        if (filter?.kind) out = out.filter((d) => d.kind === filter.kind);
        if (filter?.workspace) {
            out = out.filter((d) => {
                const ws = d.policy?.workspace ?? extractWorkspaceFromUri(d.uri);
                return ws === filter.workspace;
            });
        }
        return out;
    }

    /** Drop a kind from the registry. Returns true if it was present. */
    unregister(uri: string): boolean {
        return this.byUri.delete(uri);
    }

    /** Discard everything — for test teardown. */
    clear(): void {
        this.byUri.clear();
    }

    /** Count of registered kinds. */
    get size(): number {
        return this.byUri.size;
    }
}

/** Best-effort URI → workspace projection. URIs of shape
 *  `<workspace>://<verb>` (e.g. `marketing://cohorts`) yield the
 *  workspace name. Slashes and underscores are valid; everything
 *  before `://` is the workspace. */
function extractWorkspaceFromUri(uri: string): string | undefined {
    const idx = uri.indexOf('://');
    if (idx <= 0) return undefined;
    return uri.slice(0, idx);
}

/** Apply safe defaults to a workflow's policy. The only default
 *  applied today is `cwd: 'workspace-workdir'` when ANY step in the
 *  workflow is an agent kind and the caller didn't pin `cwd` — see
 *  the comment on `registerWorkflow` for why this is a safety
 *  invariant, not just an ergonomic shortcut.
 *
 *  Predicate is "any step is agent," not "main is agent," so it
 *  applies to both managed-agent `.md` files (single step named
 *  `main`) and multi-step DAG workflows (composed-turns YAML where
 *  the steps have author-chosen names — `research`, `draft`, etc.).
 *
 *  Exported so the runner can apply the same defaults to workflows
 *  loaded via the reader path (which bypass `registerWorkflow`). */
export function mergeWorkflowPolicyDefaults(
    declaration: WorkflowDeclaration,
    policy: KindPolicy | undefined,
): KindPolicy | undefined {
    const steps = declaration.steps;
    if (!steps) return policy;
    // Agent steps and dynamic-workflow steps both need the workspace
    // workdir + sandboxed native tools. The dynamic-workflow handler
    // materializes its `.claude/workflows/<name>.js` into the worktree
    // and reads the in-process ernesto MCP from `annotations.mcpServers`
    // — both depend on the workspace-allocator + tool-surface-composer
    // middleware chain, which only fires when `cwd === 'workspace-workdir'`.
    const needsWorkspaceWorkdir = Object.values(steps).some((s) => {
        const k = (s as { kind?: string }).kind;
        return k === 'agent' || k === 'dynamic-workflow';
    });
    if (!needsWorkspaceWorkdir) return policy;
    // Agent workflows MUST run sandboxed inside a workspace workdir.
    // Default BOTH `cwd` (so the workspace-allocator allocates the
    // workdir) AND `tools.native` (so sandbox-bind installs the
    // PreToolUse file-guard). Defaulting only `cwd` left the agent's
    // native Read/Write/Edit unguarded: `tools.native === undefined`
    // makes sandbox-bind a no-op, a silent sandbox escape. Explicit
    // author values win (e.g. `native: 'allowed'` / `'disallowed'`).
    const cwd = policy?.cwd ?? 'workspace-workdir';
    const native = policy?.tools?.native ?? 'sandboxed';
    return {
        ...(policy ?? {}),
        cwd,
        tools: { ...(policy?.tools ?? {}), native },
    };
}
