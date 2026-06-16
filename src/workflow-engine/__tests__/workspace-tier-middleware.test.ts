/**
 * Tests for the workspace-tier middleware shells:
 *   - workspaceAllocatorMiddleware
 *   - sandboxBindMiddleware
 *   - toolSurfaceComposeMiddleware
 *
 * Each is a lib shell that takes a backend-supplied hook (allocator,
 * binder, composer). Tests verify policy-driven activation, the no-op
 * path, the after-hook teardown semantics, and that the resulting
 * annotations are visible to subsequent middleware + step handlers.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { createRunner } from '../runner';
import { userPrincipal } from '../principal';
import { defineRoute } from '../../route/define-route';
import { workspaceAllocatorMiddleware } from '../middleware/workspace-allocator';
import { sandboxBindMiddleware } from '../middleware/sandbox-bind';
import { toolSurfaceComposeMiddleware } from '../middleware/tool-surface-compose';
import type { WorkflowReader, WorkflowDetail } from '../workflow-reader';
import type { WorkflowDeclaration, WorkflowStep } from '../../workflows/types';

// A workdir-bound ROUTE kind (like `code://materialize`) — used to exercise the
// allocator's "reuse the inherited parent workdir" carve-out for route kinds.
const WORKDIR_ROUTE = defineRoute({
    uri: 'code://fake-materialize',
    description: 'd',
    scope: [],
    input: z.object({}),
    output: z.object({}),
    async handler() {
        return {};
    },
});

function readerOf(decl: WorkflowDeclaration): WorkflowReader {
    const detail: WorkflowDetail = {
        name: decl.name,
        path: 'mem://w',
        sha: 'sha',
        source: 'mem',
        declaration: decl,
    };
    return {
        async list() {
            return [{ name: decl.name, path: 'mem://w', sha: 'sha' }];
        },
        async read(name: string) {
            return name === decl.name ? detail : undefined;
        },
    };
}

const STEP: WorkflowStep = { kind: 'route', uri: 'x' } as WorkflowStep;

const DECL: WorkflowDeclaration = {
    name: 'wf',
    description: 'd',
    version: 1,
    steps: { s1: STEP },
};

describe('workspaceAllocatorMiddleware', () => {
    it('allocates a workdir when policy.cwd === workspace-workdir, releases on after', async () => {
        const runner = createRunner();
        let releaseCalled = 0;
        const allocate = vi.fn(async (_ctx) => ({
            workdirRoot: '/tmp/test-workdir-1',
            release: () => {
                releaseCalled++;
            },
        }));
        let observedWorkdirRoot: string | undefined;
        runner.registerStepKind('route', async (_step, ctx) => {
            observedWorkdirRoot = ctx.workdirRoot;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, { cwd: 'workspace-workdir' });
        runner.use(workspaceAllocatorMiddleware({ allocate }));

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
        expect(allocate).toHaveBeenCalledTimes(1);
        expect(observedWorkdirRoot).toBe('/tmp/test-workdir-1');
        expect(releaseCalled).toBe(1);
    });

    it('reuses an inherited workdir for a ROUTE kind invoked as a child (no fresh allocation)', async () => {
        // A workdir-bound route (code://materialize) called from inside an
        // agent's `execute` tool: the parent threads its workdir via
        // `opts.context.workdirRoot`. The allocator must REUSE it so the route
        // hard-links bytes into the workdir the agent actually reads — not a
        // fresh throwaway one.
        const runner = createRunner();
        const allocate = vi.fn(async () => ({ workdirRoot: '/tmp/should-not-be-used' }));
        let observed: string | undefined;
        runner.registerStepKind('route', async (_step, ctx) => {
            observed = ctx.workdirRoot;
            return { kind: 'completed', output: {} };
        });
        runner.kindRegistry.registerRoute(WORKDIR_ROUTE, { cwd: 'workspace-workdir' });
        runner.use(workspaceAllocatorMiddleware({ allocate }));

        const run = await runner.dispatch('code://fake-materialize', {}, userPrincipal('u', []), {
            context: { workdirRoot: '/tmp/parent-agent-workdir' },
        });
        expect(run.status).toBe('completed');
        expect(allocate).not.toHaveBeenCalled();
        expect(observed).toBe('/tmp/parent-agent-workdir');
    });

    it('still allocates for a WORKFLOW/agent kind even when a workdir is inherited (subagent isolation)', async () => {
        // The carve-out above is route-only: a child workflow/agent dispatch
        // must get its OWN workdir, never silently share the parent's.
        const runner = createRunner();
        const allocate = vi.fn(async () => ({ workdirRoot: '/tmp/fresh-child-workdir' }));
        let observed: string | undefined;
        runner.registerStepKind('route', async (_step, ctx) => {
            observed = ctx.workdirRoot;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, { cwd: 'workspace-workdir' });
        runner.use(workspaceAllocatorMiddleware({ allocate }));

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {
            context: { workdirRoot: '/tmp/parent-agent-workdir' },
        });
        expect(run.status).toBe('completed');
        expect(allocate).toHaveBeenCalledTimes(1);
        expect(observed).toBe('/tmp/fresh-child-workdir');
    });

    it('NEGATIVE: a WORKFLOW/agent child NEVER inherits the parent workdir — must allocate its own (subagent FS isolation)', async () => {
        // boundary: workspace-allocator-subagent-isolation
        // The route-only inherit carve-out (workspace-allocator.ts:83) must
        // NOT leak to WORKFLOW/agent kinds. A child agent that silently reused
        // the parent's `opts.context.workdirRoot` could Read straight into the
        // parent's filesystem (cross-agent FS escape). Assert the secure
        // outcome directly: the step's observed workdirRoot is NOT the parent
        // path, AND a fresh workdir was allocated. We do NOT mock the
        // middleware — the real workspaceAllocatorMiddleware decides.
        const PARENT = '/tmp/parent-agent-workdir';
        const runner = createRunner();
        const allocate = vi.fn(async () => ({ workdirRoot: '/tmp/fresh-child-workdir' }));
        let observed: string | undefined;
        runner.registerStepKind('route', async (_step, ctx) => {
            observed = ctx.workdirRoot;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, { cwd: 'workspace-workdir' });
        runner.use(workspaceAllocatorMiddleware({ allocate }));

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {
            context: { workdirRoot: PARENT },
        });
        expect(run.status).toBe('completed');
        // The child must never read into the parent's workdir by inheritance.
        expect(observed).not.toBe(PARENT);
        // The isolation must come from a real fresh allocation, not a skip.
        expect(allocate).toHaveBeenCalledTimes(1);
        expect(observed).toBe('/tmp/fresh-child-workdir');
    });

    it('skips allocation when policy.cwd is ephemeral or none', async () => {
        const runner = createRunner();
        const allocate = vi.fn();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, { cwd: 'ephemeral' });
        runner.use(workspaceAllocatorMiddleware({ allocate }));

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(allocate).not.toHaveBeenCalled();
    });

    it('persistent sessions retain the workdir — release NOT called on terminal', async () => {
        const runner = createRunner();
        let releaseCalled = 0;
        const allocate = async () => ({
            workdirRoot: '/tmp/persistent',
            release: () => {
                releaseCalled++;
            },
        });
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            cwd: 'workspace-workdir',
            continuity: 'persistent',
        });
        runner.use(workspaceAllocatorMiddleware({ allocate }));

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(releaseCalled).toBe(0); // persistent → no release
    });

    it('handles allocator without a release function', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, { cwd: 'workspace-workdir' });
        runner.use(
            workspaceAllocatorMiddleware({
                allocate: async () => ({ workdirRoot: '/tmp/no-release' }),
            }),
        );

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
    });

    it('applies workspace-workdir default to reader-loaded agent-main workflows (no registerWorkflow call)', async () => {
        // Regression: managed-agent .md files load via the reader path
        // and bypass `kindRegistry.registerWorkflow`, which is where
        // `mergeWorkflowPolicyDefaults` used to be the only injection
        // point. The runner now synthesizes the same default for
        // reader-loaded workflows so workspace-tier middleware sees
        // `cwd: 'workspace-workdir'` for agent-main steps.
        const AGENT_DECL: WorkflowDeclaration = {
            name: 'reader-agent-wf',
            description: 'd',
            version: 1,
            steps: {
                main: {
                    kind: 'agent',
                    model: 'm',
                    systemPrompt: 's',
                    maxTurns: 1,
                    mcpServers: [],
                    prompt: '${{ inputs.prompt }}',
                } as WorkflowStep,
            },
        };
        const runner = createRunner();
        let observedWorkdirRoot: string | undefined;
        runner.registerStepKind('agent', async (_step, ctx) => {
            observedWorkdirRoot = ctx.workdirRoot;
            return { kind: 'completed', output: { result: 'ok' } };
        });
        runner.registerWorkflowReader(readerOf(AGENT_DECL));
        // Deliberately NOT calling kindRegistry.registerWorkflow — the
        // reader path must inject the default on its own.
        const allocate = vi.fn(async () => ({
            workdirRoot: '/tmp/reader-default-workdir',
        }));
        runner.use(workspaceAllocatorMiddleware({ allocate }));

        const run = await runner.dispatch('reader-agent-wf', { prompt: 'go' }, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
        expect(allocate).toHaveBeenCalledTimes(1);
        expect(observedWorkdirRoot).toBe('/tmp/reader-default-workdir');
    });
});

describe('sandboxBindMiddleware', () => {
    it('builds hooks when policy.tools.native === sandboxed + workdir present', async () => {
        const runner = createRunner();
        const build = vi.fn((workdirRoot: string) => `hooks-for-${workdirRoot}`);
        let observedHooks: unknown;
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            cwd: 'workspace-workdir',
            tools: { native: 'sandboxed' },
        });
        runner.use(
            workspaceAllocatorMiddleware({
                allocate: async () => ({ workdirRoot: '/tmp/sandbox-test' }),
            }),
        );
        runner.use(sandboxBindMiddleware({ binder: { build } }));
        runner.use({
            name: 'observe',
            before(ctx) {
                observedHooks = ctx.annotations.sandboxHooks;
                return ctx;
            },
        });

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(build).toHaveBeenCalledTimes(1);
        expect(build).toHaveBeenCalledWith('/tmp/sandbox-test', expect.objectContaining({ kind: 'wf' }));
        expect(observedHooks).toBe('hooks-for-/tmp/sandbox-test');
    });

    it('skips binding when tools.native is disallowed (server-tier default)', async () => {
        const runner = createRunner();
        const build = vi.fn();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            tools: { native: 'disallowed' },
        });
        runner.use(sandboxBindMiddleware({ binder: { build } }));

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(build).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED when workdir is absent (sandbox requested but unbindable) — never silently skips', async () => {
        const runner = createRunner();
        const build = vi.fn();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            // sandboxed native tools requested but NO workspace-workdir cwd
            // → no workdirRoot will be allocated. The PreToolUse path-guard
            // hooks cannot be installed; per fail-closed doctrine the
            // middleware must REFUSE, not silently pass through and let the
            // agent run native tools unsandboxed.
            tools: { native: 'sandboxed' },
        });
        runner.use(sandboxBindMiddleware({ binder: { build } }));

        await expect(runner.dispatch('wf', {}, userPrincipal('u', []), {})).rejects.toMatchObject({
            code: 'sandbox_unbindable',
        });
        // Never built hooks against a missing workdir, and never silently
        // installed nothing while permitting the step to run.
        expect(build).not.toHaveBeenCalled();
    });

    // boundary: sandbox-bind-sandboxed-without-workdir
    //
    // A kind that opted into `tools.native: 'sandboxed'` but has NO allocated
    // workdir (no workspace-allocator wired) is a SECURITY misconfiguration,
    // not a benign no-op. sandbox-bind.ts:57 does `if (!ctx.workdirRoot) return
    // ctx;` — so no PreToolUse path-guard hooks are installed AND no error is
    // raised. The agent step then runs the harness with NATIVE Read/Write/Edit/
    // Glob/Grep entirely UNSANDBOXED (full host filesystem), while the policy
    // explicitly requested confinement. The absence of a guard for a
    // sandbox-requested kind is a fail-open, not a silent no-op.
    //
    // Secure behavior (asserted in the body): the sandbox requirement must NOT
    // be silently dropped. Either the dispatch surfaces a refusal
    // (run.status === 'errored') with no hooks installed, OR a fail-closed
    // marker annotation is set so the agent step can refuse to proceed with
    // unsandboxed native tools. Today neither happens (run completes,
    // sandboxHooks undefined, workdirRoot undefined, step ran) => this is a
    // confirmed fail-open, landed skipped to keep the shared suite green.
    //
    // We use the REAL createRunner + real sandboxBindMiddleware with NO
    // allocator (mirroring a kind whose workspace-allocator was never wired) —
    // the middleware under test is never mocked.
    it('FAIL-OPEN: sandbox-bind silently no-ops when native:sandboxed but workdir missing — agent runs UNsandboxed — unskip when fixed', async () => {
        const runner = createRunner();
        const build = vi.fn((workdirRoot: string) => `hooks-for-${workdirRoot}`);
        let stepRan = false;
        let observedWorkdirRoot: string | undefined = 'UNSET' as unknown as string;
        let observedHooks: unknown = 'UNSET';
        let failClosedMarker: unknown;
        runner.registerStepKind('route', async (_step, ctx) => {
            stepRan = true;
            observedWorkdirRoot = ctx.workdirRoot;
            observedHooks = ctx.annotations.sandboxHooks;
            // A backend might mark the kind as fail-closed for sandbox.
            failClosedMarker = ctx.annotations.sandboxRequired ?? ctx.annotations.sandboxFailClosed ?? ctx.annotations.failClosed;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(DECL));
        // sandboxed native tools requested, but NO workspace-workdir cwd and
        // (below) NO allocator middleware wired → no workdirRoot will exist.
        runner.kindRegistry.registerWorkflow(DECL, {
            tools: { native: 'sandboxed' },
        });
        runner.use(sandboxBindMiddleware({ binder: { build } }));

        // The fail-closed fix raises a typed refusal from the `before` hook
        // (mirroring scope-check's ScopeEscalationError), which the runner
        // surfaces as an aborted dispatch — the documented native enforcement
        // path. Capture it as an errored run, exactly as a caller / queue
        // wrapper observes it, so the secure assertion below can read
        // `run.status`.
        const run = await runner
            .dispatch('wf', {}, userPrincipal('u', []), {})
            .catch((err) => ({ status: 'errored' as const, error: err }));

        // SECURE assertion: the agent step must NOT proceed with unsandboxed
        // native tools. The requirement is honored iff EITHER the dispatch
        // failed closed, OR a fail-closed marker was surfaced to the step.
        const failedClosed = run.status === 'errored';
        const markerSet = failClosedMarker !== undefined;
        expect(failedClosed || markerSet).toBe(true);

        // And it must never have silently installed nothing while still letting
        // an agent step run against the host FS with no workdir confinement:
        if (stepRan) {
            // If the step ran at all, hooks must have been bound to a workdir.
            expect(observedHooks).not.toBeUndefined();
            expect(observedWorkdirRoot).not.toBeUndefined();
            expect(build).toHaveBeenCalled();
        }
    });
});

describe('toolSurfaceComposeMiddleware', () => {
    it('composes when main step has mcpServers, releases teardown on terminal', async () => {
        const runner = createRunner();
        let teardownCalled = 0;
        const compose = vi.fn(async () => ({
            mcpServers: { ernesto: { cmd: 'ernesto-mcp' }, mongo: { cmd: 'mongo-mcp' } },
            teardown: () => {
                teardownCalled++;
            },
        }));
        const wf: WorkflowDeclaration = {
            name: 'wf-agent',
            description: 'd',
            version: 1,
            steps: {
                main: {
                    kind: 'agent',
                    model: 'm',
                    systemPrompt: 'sp',
                    prompt: 'p',
                    mcpServers: ['ernesto', 'mongo'],
                } as any,
            },
        };
        runner.registerStepKind('agent', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(wf));
        runner.kindRegistry.registerWorkflow(wf);
        runner.use(toolSurfaceComposeMiddleware({ composer: { compose } }));

        await runner.dispatch('wf-agent', {}, userPrincipal('u', []), {});
        expect(compose).toHaveBeenCalledTimes(1);
        expect(compose).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'wf-agent',
                mcpServers: ['ernesto', 'mongo'],
            }),
        );
        expect(teardownCalled).toBe(1);
    });

    it('composes for DAG workflows whose agent step is not named main (union across steps)', async () => {
        const runner = createRunner();
        const compose = vi.fn(async () => ({
            mcpServers: { ernesto: { cmd: 'ernesto-mcp' } },
        }));
        // The explain-settle / create-site shape: author-named agent step
        // (`write`) + a route leaf (`store`) — no step named `main`.
        const wf: WorkflowDeclaration = {
            name: 'wf-dag',
            description: 'd',
            version: 1,
            steps: {
                write: {
                    kind: 'agent',
                    model: 'm',
                    systemPrompt: 'sp',
                    prompt: 'p',
                    mcpServers: ['ernesto'],
                } as any,
                store: {
                    kind: 'call',
                    depends: ['write'],
                    uri: 'x://y',
                } as any,
            },
        };
        runner.registerStepKind('agent', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerStepKind('call', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(wf));
        runner.kindRegistry.registerWorkflow(wf);
        runner.use(toolSurfaceComposeMiddleware({ composer: { compose } }));

        await runner.dispatch('wf-dag', {}, userPrincipal('u', []), {});
        expect(compose).toHaveBeenCalledTimes(1);
        expect(compose).toHaveBeenCalledWith(expect.objectContaining({ mcpServers: ['ernesto'] }));
    });

    it('skips composition when main step has no mcpServers', async () => {
        const runner = createRunner();
        const compose = vi.fn();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL);
        runner.use(toolSurfaceComposeMiddleware({ composer: { compose } }));

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(compose).not.toHaveBeenCalled();
    });

    it('persistent session retains MCP surfaces (no teardown)', async () => {
        const runner = createRunner();
        let teardownCalled = 0;
        const compose = async () => ({
            mcpServers: { ernesto: { cmd: 'x' } },
            teardown: () => {
                teardownCalled++;
            },
        });
        const wf: WorkflowDeclaration = {
            name: 'wf-persistent',
            description: 'd',
            version: 1,
            steps: {
                main: {
                    kind: 'agent',
                    model: 'm',
                    systemPrompt: 'sp',
                    mcpServers: ['ernesto'],
                } as any,
            },
        };
        runner.registerStepKind('agent', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(wf));
        runner.kindRegistry.registerWorkflow(wf, {
            continuity: 'persistent',
        });
        runner.use(toolSurfaceComposeMiddleware({ composer: { compose } }));

        await runner.dispatch('wf-persistent', {}, userPrincipal('u', []), {
            conversationKey: 'thread-1',
        });
        expect(teardownCalled).toBe(0);
    });

    it('conversationId derived from conversationKey when present', async () => {
        const runner = createRunner();
        let observedConversationId: string | undefined;
        const compose = async (input: any) => {
            observedConversationId = input.conversationId;
            return { mcpServers: {} };
        };
        const wf: WorkflowDeclaration = {
            name: 'wf-conv',
            description: 'd',
            version: 1,
            steps: {
                main: {
                    kind: 'agent',
                    model: 'm',
                    systemPrompt: 'sp',
                    mcpServers: ['ernesto'],
                } as any,
            },
        };
        runner.registerStepKind('agent', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(wf));
        runner.kindRegistry.registerWorkflow(wf);
        runner.use(toolSurfaceComposeMiddleware({ composer: { compose } }));

        await runner.dispatch('wf-conv', {}, userPrincipal('u', []), {
            conversationKey: 'slack-thread-42',
        });
        expect(observedConversationId).toBe('slack-thread-42');
    });
});

describe('workspace-tier middleware composition', () => {
    it('allocator → sandbox-bind → tool-surface-compose work together for a workspace agent', async () => {
        const runner = createRunner();
        const events: string[] = [];

        const allocate = async () => {
            events.push('allocate');
            return {
                workdirRoot: '/tmp/wt',
                release: async () => {
                    events.push('release');
                },
            };
        };
        const build = (root: string) => {
            events.push(`bind:${root}`);
            return { gate: 'on' };
        };
        const compose = async (input: any) => {
            events.push(`compose:${input.workdirRoot}:${input.conversationId}`);
            return {
                mcpServers: { ernesto: { cmd: 'e' }, ui: { cmd: 'u' } },
                teardown: async () => {
                    events.push('teardown');
                },
            };
        };

        const wf: WorkflowDeclaration = {
            name: 'wf-full',
            description: 'd',
            version: 1,
            steps: {
                main: {
                    kind: 'agent',
                    model: 'm',
                    systemPrompt: 'sp',
                    prompt: 'p',
                    mcpServers: ['ernesto', 'ui'],
                } as any,
            },
        };
        runner.registerStepKind('agent', async (_step, _ctx) => {
            events.push('step');
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(wf));
        runner.kindRegistry.registerWorkflow(wf, {
            cwd: 'workspace-workdir',
            tools: { native: 'sandboxed' },
        });
        runner.use(workspaceAllocatorMiddleware({ allocate }));
        runner.use(sandboxBindMiddleware({ binder: { build } }));
        runner.use(toolSurfaceComposeMiddleware({ composer: { compose } }));

        await runner.dispatch('wf-full', {}, userPrincipal('alice', []), {
            conversationKey: 'thread-99',
        });

        // Verify order: allocate → bind → compose → step → teardown → release
        // Note: bind is synchronous-named but in registration order so:
        // before: allocate → bind → compose
        // step runs
        // after (reverse): teardown → release   (sandbox-bind has no after)
        expect(events).toEqual(['allocate', 'bind:/tmp/wt', 'compose:/tmp/wt:thread-99', 'step', 'teardown', 'release']);
    });
});
