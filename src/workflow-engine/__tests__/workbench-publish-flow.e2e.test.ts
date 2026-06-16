/**
 * stage → approve(convene + workbench) → publish(settle, skipIf hold)
 * — the AGENTIC-COMMIT publish shape, end to end on the real engine.
 *
 * This is the engine-level proof of the doctrine the WORKBENCH leaves
 * depend on: a workflow STAGES a draft, CONVENES a human (parking
 * durably on the signal rail), and only SETTLES when the human resolves
 * the ask WITHOUT a hold. The negative gate is load-bearing —
 * `publish.skipIf: "${{ steps.approve.value.hold }}"` is exactly the
 * shape this-week.yaml ships, so we exercise the real dotted-path
 * truthiness check, not a stand-in.
 *
 * Harness: the convene-step test idioms (fake `ConvenePort`, real
 * park/redispatch via `resumeRun`) plus a FAKE settle route handler
 * registered under `kind: 'route'` that records every settle call — so
 * `publish` running (or being skipped) is observable as a settle
 * happening (or not).
 *
 * The `publish` step here is a `route` calling `_ernesto://settle`
 * rather than an `agent` (the publish agent in this-week.yaml settles
 * by invoking that same route): the engine concern under test is
 * "does the SETTLE happen?", and a route handler lets us assert the
 * settle params verbatim without standing up a harness/SDK.
 */

import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner';
import { InMemoryStore } from '../store/in-memory-store';
import { userPrincipal } from '../principal';
import { makeConveneStepHandler, type ConvenePort, type ConveneAskRequest } from '../handlers/convene-step';
import type { EngineLogger } from '../types/handler';
import type { WorkflowDeclaration } from '../../workflows/types';
import type { WorkflowDetail, WorkflowReader } from '../workflow-reader';

const NULL_LOG: EngineLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function readerOf(decl: WorkflowDeclaration): WorkflowReader {
    const detail: WorkflowDetail = { name: decl.name, path: 'mem://w', sha: 'sha', source: 'mem', declaration: decl };
    return {
        async list() {
            return [{ name: decl.name, path: 'mem://w', sha: 'sha' }];
        },
        async read(name: string) {
            return name === decl.name ? detail : undefined;
        },
    };
}

function fakePort(): { port: ConvenePort; requests: ConveneAskRequest[] } {
    const requests: ConveneAskRequest[] = [];
    const port: ConvenePort = {
        async createAsk(request) {
            requests.push(request);
            return { askId: 'ask-row-1', deduped: false };
        },
    };
    return { port, requests };
}

/**
 * The this-week publish shape, distilled: an agent `stage` step (faked
 * as a route so we don't need a harness — the engine just needs SOME
 * upstream output to gate on), a `convene` approve with a workbench,
 * then a `publish` route that settles, gated `skipIf` on the resolved
 * `hold`. Mirrors this-week.yaml verbatim where it matters:
 * `depends`, the convene workbench, and the NEGATIVE hold gate.
 */
function publishFlowDecl(): WorkflowDeclaration {
    return {
        name: 'wf-publish-flow',
        description: 'stage -> approve -> publish(settle)',
        version: 1,
        steps: {
            stage: {
                kind: 'route',
                uri: 'stage://write-draft',
                params: { week: '2026-W24' },
            },
            approve: {
                kind: 'convene',
                depends: ['stage'],
                room: 'inbox:clement@bitrefill.com',
                title: 'Publish This Week at Bitrefill?',
                brief: 'The new weekly changelog is staged. Publish it, or hold it back.',
                subject: 'this-week-edition',
                // The workbench the inbox AskCard renders inline.
                workbench: {
                    workspaces: ['sites', 'this-week'],
                    paths: ['data/latest.json'],
                    verb: 'approve',
                    previewKind: 'edition',
                    preview: { site: 'this-week', path: 'data/latest.json' },
                } as unknown as WorkflowDeclaration['steps'][string],
            } as unknown as WorkflowDeclaration['steps'][string],
            publish: {
                kind: 'route',
                uri: '_ernesto://settle',
                depends: ['approve'],
                // The EXACT negative gate this-week.yaml ships:
                // `hold: true` SKIPS publish.
                skipIf: '${{ steps.approve.value.hold }}',
                params: {
                    workspaces: ['sites', 'this-week'],
                    message: 'this-week: edition ${{ steps.approve.value.note }}',
                },
            },
        },
    };
}

function setup() {
    const store = new InMemoryStore();
    const runner = createRunner({ store });
    const decl = publishFlowDecl();
    const { port, requests: askRequests } = fakePort();
    runner.registerStepKind('convene', makeConveneStepHandler({ port, log: NULL_LOG }));
    runner.registerWorkflowReader(readerOf(decl));

    // FAKE settle route handler: records every settle call so we can
    // assert whether `publish` ran. `stage://write-draft` is the same
    // handler (records nothing meaningful for stage; we only care about
    // the settle URI).
    const settleCalls: Array<Record<string, unknown> | undefined> = [];
    runner.registerStepKind('route', async (step) => {
        const s = step as { uri: string; params?: Record<string, unknown> };
        if (s.uri === '_ernesto://settle') {
            settleCalls.push(s.params);
            return { kind: 'completed', output: { settled: true, sha: 'deadbeef' } };
        }
        return { kind: 'completed', output: { staged: true } };
    });

    return { store, runner, askRequests, settleCalls };
}

describe('stage → approve(convene+workbench) → publish(settle, skipIf hold)', () => {
    it('APPROVE (hold:false): the run parks on the ask, then resuming with hold:false RUNS the settle step', async () => {
        const { store, runner, askRequests, settleCalls } = setup();

        const run = await runner.dispatch('wf-publish-flow', {}, userPrincipal('clement', ['rooms:read', 'rooms:post']), {});
        // Parked at the convene step — stage ran, publish has NOT.
        expect(run.status).toBe('awaiting_input');
        expect(askRequests).toHaveLength(1);
        // The workbench rode through to the port (the inbox AskCard surface).
        const wb = askRequests[0]!.workbench;
        expect(wb?.verb).toBe('approve');
        expect(wb?.workspaces).toEqual(['sites', 'this-week']);
        expect(wb?.paths).toEqual(['data/latest.json']);
        // No settle yet — nothing has published.
        expect(settleCalls).toHaveLength(0);

        const pause = (await store.getRunState(run.runId))!.resume!.paused[0]!;

        // The human approves: hold:false — the run resumes and PUBLISHES.
        await runner.resumeRun({
            runId: run.runId,
            promptId: pause.promptId,
            value: { outcome: 'resolved', value: { hold: false, note: '2026-W24' }, resolverUserId: 'clement' },
        });

        expect((await store.getRunState(run.runId))?.status).toBe('completed');
        // PUBLISH RAN: exactly one settle, with the staged workspaces + a
        // message interpolated from the resolved ask value.
        expect(settleCalls).toHaveLength(1);
        expect(settleCalls[0]).toEqual({
            workspaces: ['sites', 'this-week'],
            message: 'this-week: edition 2026-W24',
        });
    });

    it('HOLD (hold:true): resuming with hold:true SKIPS publish — no settle ever fires', async () => {
        const { store, runner, settleCalls } = setup();

        const run = await runner.dispatch('wf-publish-flow', {}, userPrincipal('clement', ['rooms:read', 'rooms:post']), {});
        expect(run.status).toBe('awaiting_input');
        const pause = (await store.getRunState(run.runId))!.resume!.paused[0]!;

        // The human holds it back: hold:true — skipIf is truthy → publish skipped.
        await runner.resumeRun({
            runId: run.runId,
            promptId: pause.promptId,
            value: { outcome: 'resolved', value: { hold: true }, resolverUserId: 'clement' },
        });

        const final = await store.getRunState(run.runId);
        expect(final?.status).toBe('completed');
        // PUBLISH SKIPPED: the negative gate held — nothing settled.
        expect(settleCalls).toHaveLength(0);
    });

    it("TIMEOUT: an expired ask resumes with outcome:timeout — hold is undefined (falsy) so the gate is the AUTHOR's problem, but value.hold absent → publish RUNS", async () => {
        // A subtle but real property of the shipped gate: on timeout the
        // convene output is `{ outcome: 'timeout' }` with NO `value`, so
        // `${{ steps.approve.value.hold }}` resolves undefined (falsy) and
        // publish RUNS. This test PINS that behavior so a future author
        // who wants timeout to HOLD knows they must widen the skipIf
        // (e.g. `|| steps.approve.outcome == 'timeout'`) — it is not
        // implicit. Documents the seam rather than asserting a "should".
        const { store, runner, settleCalls } = setup();
        const run = await runner.dispatch('wf-publish-flow', {}, userPrincipal('clement', ['rooms:read']), {});
        const pause = (await store.getRunState(run.runId))!.resume!.paused[0]!;

        await runner.resumeRun({ runId: run.runId, promptId: pause.promptId, value: { outcome: 'timeout' } });

        expect((await store.getRunState(run.runId))?.status).toBe('completed');
        // No `value.hold` → falsy → publish ran. (The message interpolates
        // the absent note to empty.)
        expect(settleCalls).toHaveLength(1);
        expect(settleCalls[0]).toEqual({ workspaces: ['sites', 'this-week'], message: 'this-week: edition ' });
    });
});
