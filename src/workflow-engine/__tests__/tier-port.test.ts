/**
 * TierPort tests.
 *
 * The lib defines the contract + tail loop; concrete tier subscribers
 * (Slack, claude.ai MCP, CLI, ernesto-MCP) live in backend modules.
 * These tests exercise the base lifecycle against a recording mock —
 * proving every event passes through filter → render, and HITL pauses
 * route through resolveHitl + runner.resumeRun cleanly.
 */

import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner';
import { userPrincipal } from '../principal';
import { TierPort, type HitlPauseRequest } from '../tier-port';
import type { FactEvent } from '../types/event';
import type { WorkflowReader, WorkflowDetail } from '../workflow-reader';
import type { WorkflowDeclaration, WorkflowStep } from '../../workflows/types';
import type { WorkflowRunner } from '../types/runner';

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

/** Mock TierPort that records every render call + answers HITL with a
 *  canned value. */
class RecordingTierPort extends TierPort {
    readonly rendered: FactEvent[] = [];
    readonly hitlPauses: HitlPauseRequest[] = [];
    hitlAnswer: unknown = { choice: 'a' };

    render(event: FactEvent): void {
        this.rendered.push(event);
    }

    async resolveHitl(pause: HitlPauseRequest): Promise<unknown> {
        this.hitlPauses.push(pause);
        return this.hitlAnswer;
    }
}

describe('TierPort', () => {
    it('routes filtered events to render() and surfaces submit() through the runner', async () => {
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

        const port = new RecordingTierPort(runner, { tier: 'A' });
        const stop = await port.start();
        try {
            const run = await port.submit('wf', {}, userPrincipal('u', []), {
                tier: 'A',
            });
            expect(run.status).toBe('completed');
            // Tail loop is async — give it a tick to drain.
            await new Promise((r) => setImmediate(r));
            const types = port.rendered.map((e) => e.type);
            expect(types).toContain('fact.run_started');
            expect(types).toContain('fact.run_terminated');
            // Every rendered event carries the tier-A routing.
            for (const ev of port.rendered) {
                const routing = ev.routing as { tier?: string } | undefined;
                expect(routing?.tier).toBe('A');
            }
        } finally {
            await stop();
        }
    });

    it('filters out events from other tiers', async () => {
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

        const portA = new RecordingTierPort(runner, { tier: 'A' });
        const portB = new RecordingTierPort(runner, { tier: 'B' });
        const stopA = await portA.start();
        const stopB = await portB.start();
        try {
            await runner.dispatch('wf', {}, userPrincipal('u', []), { tier: 'A' });
            await new Promise((r) => setImmediate(r));
            expect(portA.rendered.length).toBeGreaterThan(0);
            expect(portB.rendered.length).toBe(0); // tier-B port sees nothing
        } finally {
            await stopA();
            await stopB();
        }
    });

    it('filters by surfaceRunId — only the matching dispatch tree is seen', async () => {
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

        const port = new RecordingTierPort(runner, {
            surfaceRunId: 'surface-mine',
        });
        const stop = await port.start();
        try {
            // Dispatch with surfaceRunId set — events should be captured
            await runner.dispatch('wf', {}, userPrincipal('u', []), {
                surfaceRunId: 'surface-mine',
            });
            // Different surfaceRunId — should be ignored
            await runner.dispatch('wf', {}, userPrincipal('u', []), {
                surfaceRunId: 'surface-other',
            });
            await new Promise((r) => setImmediate(r));
            // All rendered events must have surfaceRunId === 'surface-mine'
            for (const ev of port.rendered) {
                const routing = ev.routing as { surfaceRunId?: string } | undefined;
                expect(routing?.surfaceRunId).toBe('surface-mine');
            }
            expect(port.rendered.length).toBeGreaterThan(0);
        } finally {
            await stop();
        }
    });

    it('routes fact.run_paused_human through resolveHitl + runner.resumeRun', async () => {
        const runner = createRunner();
        runner.registerStepKind('input', async () => ({
            kind: 'paused_human',
            prompt: 'Pick a',
            routes: ['a', 'b'],
            schema: {
                type: 'object',
                properties: { choice: { type: 'string', enum: ['a', 'b'] } },
                required: ['choice'],
            },
        }));
        runner.registerWorkflowReader(
            readerOf({
                name: 'wf-hitl',
                description: 'd',
                version: 1,
                steps: { s1: { kind: 'input', schema: {} as any, prompt: 'p' } },
            }),
        );

        const port = new RecordingTierPort(runner, { tier: 'A' });
        const stop = await port.start();
        try {
            const run = await port.submit(
                'wf-hitl',
                {},
                userPrincipal('u', []),
                { tier: 'A' },
            );
            expect(run.status).toBe('completed');
            await new Promise((r) => setImmediate(r));
            // resolveHitl was invoked
            expect(port.hitlPauses).toHaveLength(1);
            expect(port.hitlPauses[0]!.routes).toEqual(['a', 'b']);
            expect(port.hitlPauses[0]!.prompt).toBe('Pick a');
            expect(port.hitlPauses[0]!.schema).toMatchObject({
                type: 'object',
                properties: { choice: { type: 'string', enum: ['a', 'b'] } },
            });
            // Final step output is the canned answer (`{choice: 'a'}`).
            expect((run.output as any).s1).toEqual({ choice: 'a' });
        } finally {
            await stop();
        }
    });

    it('survives renderer exceptions without breaking the tail loop', async () => {
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

        // A renderer that throws on every event
        class ThrowingPort extends TierPort {
            renderCount = 0;
            render(): never {
                this.renderCount++;
                throw new Error('renderer broken');
            }
            async resolveHitl(): Promise<unknown> {
                return null;
            }
        }
        const port = new ThrowingPort(runner, { tier: 'A' });
        const stop = await port.start();
        try {
            // Dispatch must NOT throw — port errors are swallowed.
            const run = await runner.dispatch('wf', {}, userPrincipal('u', []), {
                tier: 'A',
            });
            expect(run.status).toBe('completed');
            await new Promise((r) => setImmediate(r));
            // Renderer was called even though it threw on every event
            expect(port.renderCount).toBeGreaterThan(0);
        } finally {
            await stop();
        }
    });

    it('predicate filter narrows further — e.g. only run_terminated events', async () => {
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

        const port = new RecordingTierPort(runner, {
            predicate: (ev) => ev.type === 'fact.run_terminated',
        });
        const stop = await port.start();
        try {
            await runner.dispatch('wf', {}, userPrincipal('u', []), {});
            await new Promise((r) => setImmediate(r));
            expect(port.rendered.every((e) => e.type === 'fact.run_terminated')).toBe(
                true,
            );
            expect(port.rendered.length).toBeGreaterThan(0);
        } finally {
            await stop();
        }
    });

    it('contract type accepts WorkflowRunner mocks for testing', () => {
        // Verifies the abstract base is instantiable against a stub
        // runner — useful for backend tests that don't want a real
        // runner.
        const stubRunner: WorkflowRunner = {
            registerStepKind: () => {},
            registerWorkflowReader: () => {},
            subscribeEvents: async () => ({ close: async () => {} }),
            dispatch: async () => ({} as any),
            resumeRun: async () => {},
            abortRun: async () => {},
            emitFactEvent: () => {},
            pauseForHuman: async () => null,
        };
        const port = new RecordingTierPort(stubRunner, { tier: 'A' });
        expect(port).toBeInstanceOf(TierPort);
    });
});
