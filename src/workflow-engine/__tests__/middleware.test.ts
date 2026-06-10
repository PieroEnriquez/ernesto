/**
 * M6 tests — middleware chain + scope-check middleware.
 */

import { describe, it, expect, vi } from 'vitest';
import { createRunner } from '../runner';
import { userPrincipal, servicePrincipal } from '../principal';
import { scopeCheckMiddleware, ScopeEscalationError } from '../middleware/scope-check';
import type { DispatchMiddleware } from '../middleware';
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

describe('runner.use() — middleware chain', () => {
    it('runs before hooks in registration order, after hooks in reverse', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: { ok: true },
        }));
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf',
                description: 'd',
                version: 1,
                steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
            }),
        );

        const trace: string[] = [];
        const mwA: DispatchMiddleware = {
            name: 'A',
            before(ctx) {
                trace.push('A:before');
                return ctx;
            },
            after() {
                trace.push('A:after');
            },
        };
        const mwB: DispatchMiddleware = {
            name: 'B',
            before(ctx) {
                trace.push('B:before');
                return ctx;
            },
            after() {
                trace.push('B:after');
            },
        };
        const mwC: DispatchMiddleware = {
            name: 'C',
            before(ctx) {
                trace.push('C:before');
                return ctx;
            },
            after() {
                trace.push('C:after');
            },
        };
        runner.use(mwA);
        runner.use(mwB);
        runner.use(mwC);

        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
        expect(trace).toEqual([
            'A:before',
            'B:before',
            'C:before',
            // Walk runs in between (no trace from it)
            'C:after',
            'B:after',
            'A:after',
        ]);
    });

    it('before-hook can transform inputs/opts that the walker sees', async () => {
        const runner = createRunner();
        let observed: unknown;
        runner.registerStepKind('route', async (_step, ctx) => {
            observed = ctx.routing.context;
            return { kind: 'completed', output: {} };
        });
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf',
                description: 'd',
                version: 1,
                steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
            }),
        );
        runner.use({
            name: 'context-injector',
            before(ctx) {
                ctx.opts = { ...ctx.opts, context: { injected: true } };
                return ctx;
            },
        });

        await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect((observed as { injected?: boolean })?.injected).toBe(true);
    });

    it('before-hook throwing aborts the dispatch (no walk, no after)', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf',
                description: 'd',
                version: 1,
                steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
            }),
        );

        const afterSpy = vi.fn();
        runner.use({
            name: 'blocker',
            before() {
                throw new Error('blocked');
            },
            after: afterSpy,
        });

        await expect(runner.dispatch('wf', {}, userPrincipal('u', []), {})).rejects.toThrow(/blocked/);
        expect(afterSpy).not.toHaveBeenCalled();
    });

    it('after-hook errors are logged + dropped (run terminal is the source of truth)', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: { ok: true },
        }));
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf',
                description: 'd',
                version: 1,
                steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
            }),
        );

        runner.use({
            name: 'broken-after',
            after() {
                throw new Error('cleanup broke');
            },
        });

        // Dispatch resolves normally; the after-hook error is swallowed.
        const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
    });

    it('decl is resolved + passed to middleware before-hooks', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-with-scope',
            description: 'd',
            version: 1,
            scope: ['marketing:read'],
            steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
        };
        runner.registerWorkflowReader(readerOf(decl));
        runner.kindRegistry.registerWorkflow(decl);

        let observedScope: string[] | undefined;
        runner.use({
            name: 'observer',
            before(ctx) {
                if (ctx.decl?.kind === 'workflow') {
                    observedScope = ctx.decl.declaration.scope;
                }
                return ctx;
            },
        });

        await runner.dispatch('wf-with-scope', {}, userPrincipal('u', ['marketing:read']), {});
        expect(observedScope).toEqual(['marketing:read']);
    });
});

describe('scopeCheckMiddleware', () => {
    it('throws ScopeEscalationError when user principal lacks declared scope', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-restricted',
            description: 'd',
            version: 1,
            scope: ['marketing:write'],
            steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
        };
        runner.registerWorkflowReader(readerOf(decl));
        runner.kindRegistry.registerWorkflow(decl);
        runner.use(scopeCheckMiddleware());

        await expect(runner.dispatch('wf-restricted', {}, userPrincipal('alice', ['marketing:read']), {})).rejects.toThrow(
            ScopeEscalationError,
        );
    });

    it('passes when user principal has the declared scope', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: { ok: true },
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-ok',
            description: 'd',
            version: 1,
            scope: ['marketing:read'],
            steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
        };
        runner.registerWorkflowReader(readerOf(decl));
        runner.kindRegistry.registerWorkflow(decl);
        runner.use(scopeCheckMiddleware());

        const run = await runner.dispatch('wf-ok', {}, userPrincipal('alice', ['marketing:read', 'marketing:write']), {});
        expect(run.status).toBe('completed');
    });

    it('service principals bypass when allowlist === "all"', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-svc',
            description: 'd',
            version: 1,
            scope: ['marketing:write', 'payments:read'],
            steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
        };
        runner.registerWorkflowReader(readerOf(decl));
        runner.kindRegistry.registerWorkflow(decl);
        runner.use(scopeCheckMiddleware()); // default: serviceAllowlist === 'all'

        const run = await runner.dispatch('wf-svc', {}, servicePrincipal('autofill-worker', 'req-1'), {});
        expect(run.status).toBe('completed');
    });

    it('service principal NOT on a strict allowlist falls through to strict check', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-strict',
            description: 'd',
            version: 1,
            scope: ['marketing:write'],
            steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
        };
        runner.registerWorkflowReader(readerOf(decl));
        runner.kindRegistry.registerWorkflow(decl);
        runner.use(
            scopeCheckMiddleware({
                serviceAllowlist: new Set(['trusted-worker']),
            }),
        );

        // Untrusted worker rejected
        await expect(runner.dispatch('wf-strict', {}, servicePrincipal('untrusted', 'req-1'), {})).rejects.toThrow(ScopeEscalationError);

        // Trusted worker passes
        const ok = await runner.dispatch('wf-strict', {}, servicePrincipal('trusted-worker', 'req-1'), {});
        expect(ok.status).toBe('completed');
    });

    it('kind with no declared scope passes unconditionally', async () => {
        const runner = createRunner();
        runner.registerStepKind('route', async () => ({
            kind: 'completed',
            output: {},
        }));
        const decl: WorkflowDeclaration = {
            name: 'wf-open',
            description: 'd',
            version: 1,
            // no scope field
            steps: { s1: { kind: 'route', uri: 'x' } as WorkflowStep },
        };
        runner.registerWorkflowReader(readerOf(decl));
        runner.kindRegistry.registerWorkflow(decl);
        runner.use(scopeCheckMiddleware());

        const run = await runner.dispatch('wf-open', {}, userPrincipal('u', []), {});
        expect(run.status).toBe('completed');
    });
});
