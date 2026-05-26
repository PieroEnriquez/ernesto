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
import { createRunner } from '../runner';
import { userPrincipal } from '../principal';
import { workspaceAllocatorMiddleware } from '../middleware/workspace-allocator';
import { sandboxBindMiddleware } from '../middleware/sandbox-bind';
import { toolSurfaceComposeMiddleware } from '../middleware/tool-surface-compose';
import type { WorkflowReader, WorkflowDetail } from '../workflow-reader';
import type { WorkflowDeclaration, WorkflowStep } from '../../workflows/types';

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
            sessionContinuity: 'persistent',
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
});

describe('sandboxBindMiddleware', () => {
    it('builds hooks when policy.tools.native === sandboxed + workdir present', async () => {
        const runner = createRunner();
        const build = vi.fn(
            (workdirRoot: string) => `hooks-for-${workdirRoot}`,
        );
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
        expect(build).toHaveBeenCalledWith(
            '/tmp/sandbox-test',
            expect.objectContaining({ kind: 'wf' }),
        );
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

    it('skips binding when workdir is absent (kind policy misconfigured)', async () => {
        const runner = createRunner();
        const build = vi.fn();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(DECL));
        runner.kindRegistry.registerWorkflow(DECL, {
            // sandboxed but no workspace-workdir — misconfiguration;
            // binder skips, kind handler will surface the issue.
            tools: { native: 'sandboxed' },
        });
        runner.use(sandboxBindMiddleware({ binder: { build } }));

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(build).not.toHaveBeenCalled();
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
            sessionContinuity: 'persistent',
        });
        runner.use(toolSurfaceComposeMiddleware({ composer: { compose } }));

        await runner.dispatch('wf-persistent', {}, userPrincipal('u', []), {
            conversationKey: 'thread-1',
        });
        expect(teardownCalled).toBe(0);
    });

    it('sessionId derived from conversationKey when present', async () => {
        const runner = createRunner();
        let observedSessionId: string | undefined;
        const compose = async (input: any) => {
            observedSessionId = input.sessionId;
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
        expect(observedSessionId).toBe('slack-thread-42');
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
            events.push(`compose:${input.workdirRoot}:${input.sessionId}`);
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
        expect(events).toEqual([
            'allocate',
            'bind:/tmp/wt',
            'compose:/tmp/wt:thread-99',
            'step',
            'teardown',
            'release',
        ]);
    });
});
