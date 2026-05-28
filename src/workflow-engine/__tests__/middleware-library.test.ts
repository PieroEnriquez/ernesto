/**
 * Tests for the M6 concrete middleware library:
 *   - modelRouterMiddleware
 *   - timeoutMiddleware
 *   - loggingMiddleware
 */

import { describe, it, expect, vi } from 'vitest';
import { createRunner } from '../runner';
import { userPrincipal, servicePrincipal } from '../principal';
import {
    modelRouterMiddleware,
    ModelRouterError,
} from '../middleware/model-router';
import { timeoutMiddleware } from '../middleware/timeout';
import { loggingMiddleware } from '../middleware/logging';
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

const SIMPLE_DECL: WorkflowDeclaration = {
    name: 'wf',
    description: 'd',
    version: 1,
    steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
};

describe('modelRouterMiddleware', () => {
    it('writes provider env to annotations from kind.policy.provider', async () => {
        const runner = createRunner();
        let observedAnnotations: Record<string, unknown> | undefined;
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.kindRegistry.registerWorkflow(SIMPLE_DECL, {
            provider: 'ANTHROPIC',
            model: 'claude-sonnet-4-6',
        });
        runner.use(modelRouterMiddleware());
        runner.use({
            name: 'observe',
            before(ctx) {
                observedAnnotations = ctx.annotations;
                return ctx;
            },
        });

        // Ensure the env key exists for this test
        const savedKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-test-anth';
        try {
            await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        } finally {
            if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = savedKey;
        }
        expect(observedAnnotations?.provider).toBe('ANTHROPIC');
        expect(observedAnnotations?.model).toBe('claude-sonnet-4-6');
        expect(observedAnnotations?.providerEnv).toMatchObject({
            ANTHROPIC_API_KEY: 'sk-test-anth',
        });
    });

    it('throws ModelRouterError when provider env key is missing', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.kindRegistry.registerWorkflow(SIMPLE_DECL, {
            provider: 'OPEN_ROUTER',
            model: 'kimi-k2.6',
        });
        runner.use(modelRouterMiddleware());

        const saved = process.env.OPENROUTER_API_KEY;
        delete process.env.OPENROUTER_API_KEY;
        try {
            await expect(
                runner.dispatch('wf', {}, userPrincipal('u', []), {}),
            ).rejects.toThrow(ModelRouterError);
        } finally {
            if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
        }
    });

    it('no-op when kind has no provider/model policy', async () => {
        const runner = createRunner();
        let observed: Record<string, unknown> | undefined;
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.kindRegistry.registerWorkflow(SIMPLE_DECL);
        runner.use(modelRouterMiddleware());
        runner.use({
            name: 'observe',
            before(ctx) {
                observed = ctx.annotations;
                return ctx;
            },
        });

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(observed?.provider).toBeUndefined();
        expect(observed?.providerEnv).toBeUndefined();
    });

    it('custom provider resolver via providerEnv option', async () => {
        const runner = createRunner();
        let observed: Record<string, unknown> | undefined;
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.kindRegistry.registerWorkflow(SIMPLE_DECL, {
            provider: 'CUSTOM_VENDOR' as any,
            model: 'custom-model',
        });
        runner.use(
            modelRouterMiddleware({
                providerEnv: {
                    CUSTOM_VENDOR: () => ({ CUSTOM_VENDOR_KEY: 'fake' }),
                },
            }),
        );
        runner.use({
            name: 'observe',
            before(ctx) {
                observed = ctx.annotations;
                return ctx;
            },
        });
        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(observed?.providerEnv).toEqual({ CUSTOM_VENDOR_KEY: 'fake' });
    });
});

describe('timeoutMiddleware', () => {
    it('composes timeoutMs into ctx.opts.abortSignal', async () => {
        const runner = createRunner();
        let observedSignal: AbortSignal | undefined;
        runner.registerStepKind('route', async (_step, ctx) => {
            observedSignal = ctx.signal;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.kindRegistry.registerWorkflow(SIMPLE_DECL, { timeoutMs: 50 });
        runner.use(timeoutMiddleware());

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        // After the run completes, the after-hook should have cleared
        // the timer; the signal should NOT be aborted because the run
        // finished fast.
        expect(observedSignal).toBeDefined();
        expect(observedSignal!.aborted).toBe(false);
    });

    it('fires abort when run exceeds timeout', async () => {
        const runner = createRunner();
        let stepAborted = false;
        runner.registerStepKind('route', async (_step, ctx) => {
            return await new Promise((resolve) => {
                ctx.signal.addEventListener(
                    'abort',
                    () => {
                        stepAborted = true;
                        resolve({
                            kind: 'error',
                            code: 'aborted',
                            message: 'timed out',
                        });
                    },
                    { once: true },
                );
            });
        });
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.kindRegistry.registerWorkflow(SIMPLE_DECL, { timeoutMs: 20 });
        runner.use(timeoutMiddleware());

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(stepAborted).toBe(true);
        expect(['errored', 'canceled']).toContain(run.status);
    });

    it('no-op when kind has no timeoutMs policy', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.kindRegistry.registerWorkflow(SIMPLE_DECL); // no policy
        runner.use(timeoutMiddleware());
        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
    });

    it('parent abort signal still wins (composed signal)', async () => {
        const runner = createRunner();
        let stepAborted = false;
        runner.registerStepKind('route', async (_step, ctx) => {
            return await new Promise((resolve) => {
                ctx.signal.addEventListener(
                    'abort',
                    () => {
                        stepAborted = true;
                        resolve({ kind: 'error', code: 'aborted', message: 'cancel' });
                    },
                    { once: true },
                );
            });
        });
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.kindRegistry.registerWorkflow(SIMPLE_DECL, { timeoutMs: 60_000 });
        runner.use(timeoutMiddleware());

        const ac = new AbortController();
        const dispatchPromise = runner.dispatch(
            'wf',
            {},
            userPrincipal('u', []),
            { abortSignal: ac.signal },
        );
        setTimeout(() => ac.abort(), 10);
        const run = await dispatchPromise;
        expect(stepAborted).toBe(true);
        expect(['errored', 'canceled']).toContain(run.status);
    });
});

describe('loggingMiddleware', () => {
    it('logs dispatch start + end with structured metadata', async () => {
        const runner = createRunner();
        const logs: Array<{ msg: string; meta?: unknown }> = [];
        const log = {
            info: (msg: string, meta?: unknown) => logs.push({ msg, meta }),
            warn: (msg: string, meta?: unknown) => logs.push({ msg, meta }),
        };
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.use(loggingMiddleware({ log }));

        await runner.dispatch(
            'wf',
            {},
            userPrincipal('alice', []),
            { tier: 'A', surfaceRunId: 'surf-1' },
        );

        expect(logs.length).toBe(2);
        expect(logs[0]!.msg).toBe('dispatch start');
        expect(logs[0]!.meta).toMatchObject({
            kind: 'wf',
            principal: 'user:alice',
            tier: 'A',
            surfaceRunId: 'surf-1',
        });
        expect(logs[1]!.msg).toBe('dispatch end');
        expect(logs[1]!.meta).toMatchObject({
            status: 'completed',
            kind: 'wf',
        });
    });

    it('logs errored runs with warn level + error fields', async () => {
        const runner = createRunner();
        const logs: Array<{ msg: string; level: 'info' | 'warn'; meta?: unknown }> = [];
        const log = {
            info: (msg: string, meta?: unknown) =>
                logs.push({ msg, level: 'info', meta }),
            warn: (msg: string, meta?: unknown) =>
                logs.push({ msg, level: 'warn', meta }),
        };
        runner.registerStepKind('route', async () => ({
            kind: 'error',
            code: 'boom',
            message: 'oh no',
        }));
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.use(loggingMiddleware({ log }));

        await runner.dispatch('wf', {}, servicePrincipal('w', 'r1'), {});

        const end = logs.find((l) => l.msg === 'dispatch errored');
        expect(end).toBeDefined();
        expect(end?.level).toBe('warn');
        expect(end?.meta).toMatchObject({
            errorCode: 'boom',
            errorMessage: 'oh no',
        });
    });

    it('respects redact() to mask sensitive metadata', async () => {
        const runner = createRunner();
        const logs: Array<unknown> = [];
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.use(
            loggingMiddleware({
                log: {
                    info: (_msg, meta) => logs.push(meta),
                    warn: (_msg, meta) => logs.push(meta),
                },
                redact: (m) => {
                    const out = { ...m };
                    if ('principal' in out) out.principal = 'REDACTED';
                    return out;
                },
            }),
        );

        await runner.dispatch('wf', {}, userPrincipal('alice', []), {});
        expect((logs[0] as { principal?: string }).principal).toBe('REDACTED');
    });

    it('default no-op logger does not throw', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(readerOf(SIMPLE_DECL));
        runner.use(loggingMiddleware()); // default no-op
        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
    });
});

describe('scopeCheckMiddleware admin bypass', () => {
    const SCOPED_DECL: WorkflowDeclaration = {
        name: 'wf-scoped',
        description: 'd',
        version: 1,
        scope: ['recruiting:write'],
        steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
    };

    async function runWith(
        callerScopes: string[],
        adminBypassScopes?: string[],
    ) {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: { ok: true },
        }));
        runner.registerWorkflowReader(readerOf(SCOPED_DECL));
        runner.kindRegistry.registerWorkflow(SCOPED_DECL, {
            provider: 'ANTHROPIC',
            model: 'claude-sonnet-4-6',
        });
        const { scopeCheckMiddleware } = await import('../middleware/scope-check');
        runner.use(
            scopeCheckMiddleware(
                adminBypassScopes ? { adminBypassScopes } : {},
            ),
        );
        return runner.dispatch(
            'wf-scoped',
            {},
            userPrincipal('alice', callerScopes),
            {},
        );
    }

    it('rejects a caller lacking the declared scope (no bypass configured)', async () => {
        await expect(runWith(['ernesto:agent-ops'])).rejects.toMatchObject({
            code: 'scope_escalation',
        });
    });

    it('admits a caller holding an admin bypass scope', async () => {
        const run = await runWith(['ernesto:agent-ops'], ['ernesto:agent-ops']);
        expect(run.status).toBe('completed');
    });

    it('still rejects a caller without the bypass scope even when bypass is configured', async () => {
        await expect(
            runWith(['marketing:read'], ['ernesto:agent-ops']),
        ).rejects.toMatchObject({ code: 'scope_escalation' });
    });
});

describe('M6 middleware composition — three together', () => {
    it('scope-check + model-router + logging + timeout cooperate end-to-end', async () => {
        const runner = createRunner();
        const logs: Array<{ msg: string }> = [];
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: { ok: true },
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-stack',
            description: 'd',
            version: 1,
            scope: ['marketing:read'],
            steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
        };
        runner.registerWorkflowReader(readerOf(decl));
        runner.kindRegistry.registerWorkflow(decl, {
            provider: 'ANTHROPIC',
            model: 'claude-sonnet-4-6',
            timeoutMs: 5_000,
        });

        // Order matters: log → scope → timeout → model-router.
        const { scopeCheckMiddleware } = await import('../middleware/scope-check');
        runner.use(
            loggingMiddleware({
                log: {
                    info: (msg) => logs.push({ msg }),
                    warn: (msg) => logs.push({ msg }),
                },
            }),
        );
        runner.use(scopeCheckMiddleware());
        runner.use(timeoutMiddleware());

        const savedKey = process.env.ANTHROPIC_API_KEY;
        process.env.ANTHROPIC_API_KEY = 'sk-test';
        try {
            runner.use(modelRouterMiddleware());
            const run = await runner.dispatch(
                'wf-stack',
                {},
                userPrincipal('alice', ['marketing:read']),
                {},
            );
            expect(run.status).toBe('completed');
            // Both logging events fired
            expect(logs.map((l) => l.msg)).toContain('dispatch start');
            expect(logs.map((l) => l.msg)).toContain('dispatch end');
        } finally {
            if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
            else process.env.ANTHROPIC_API_KEY = savedKey;
        }
    });
});
