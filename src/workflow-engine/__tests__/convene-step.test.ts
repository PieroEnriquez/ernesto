/**
 * `convene` step kind — ask-in-a-room pause on the durable signal rail.
 *
 * Mirrors the runner/hitl test idioms: a fake `ConvenePort` stands in
 * for the backend rooms adapter; the engine's own park/redispatch
 * machinery (paused_signal → durable resume blob → `resumeRun`) is the
 * real thing, end to end.
 */

import { describe, it, expect } from 'vitest';
import { createRunner } from '../runner';
import { InMemoryStore } from '../store/in-memory-store';
import { userPrincipal, servicePrincipal } from '../principal';
import {
    makeConveneStepHandler,
    parseConveneRoomTarget,
    DEFAULT_CONVENE_VALUE_SCHEMA,
    CONVENE_RESUME_ENVELOPE_SCHEMA,
    type ConveneAskReceipt,
    type ConveneAskRequest,
    type ConvenePort,
} from '../handlers/convene-step';
import type { EngineLogger } from '../types/handler';
import type { FactEvent } from '../types/event';
import type { WorkflowDeclaration, WorkflowStep } from '../../workflows/types';
import type { WorkflowDetail, WorkflowReader } from '../workflow-reader';

const NULL_LOG: EngineLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

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
            if (name !== decl.name) return undefined;
            return detail;
        },
    };
}

/** Fake backend adapter: records every request, answers with a canned
 *  receipt (or throws, when `fail` is set). */
function fakePort(opts: { receipt?: Partial<ConveneAskReceipt>; fail?: Error } = {}): {
    port: ConvenePort;
    requests: ConveneAskRequest[];
} {
    const requests: ConveneAskRequest[] = [];
    const port: ConvenePort = {
        async createAsk(request) {
            requests.push(request);
            if (opts.fail) throw opts.fail;
            return { askId: 'ask-row-1', deduped: false, ...opts.receipt };
        },
    };
    return { port, requests };
}

function conveneDecl(step: Record<string, unknown>, extraSteps: Record<string, WorkflowStep> = {}): WorkflowDeclaration {
    return {
        name: 'wf-convene',
        description: 'd',
        version: 1,
        steps: {
            ask: step as unknown as WorkflowStep,
            ...extraSteps,
        },
    };
}

function setup(decl: WorkflowDeclaration, portOpts: Parameters<typeof fakePort>[0] = {}) {
    const store = new InMemoryStore();
    const runner = createRunner({ store });
    const { port, requests } = fakePort(portOpts);
    runner.registerStepKind('convene', makeConveneStepHandler({ port, log: NULL_LOG }));
    runner.registerWorkflowReader(readerOf(decl));
    return { store, runner, requests };
}

describe('convene step handler', () => {
    it('parks on the askToken and resumeRun completes with the typed result (full round trip)', async () => {
        // Downstream step proves the resume envelope flows into
        // `${{ steps.ask.outputs.X }}` references.
        let downstreamParams: Record<string, unknown> | undefined;
        const decl = conveneDecl(
            {
                kind: 'convene',
                room: 'room-7',
                title: 'Approve the May payout',
                brief: 'Finance needs a yes or no on the May payout before Friday.',
                nudgeAfterSec: 3600,
                expireAfterSec: 86400,
            },
            {
                after: {
                    kind: 'route',
                    uri: 'x://y',
                    depends: ['ask'],
                    params: {
                        outcome: '${{ steps.ask.outputs.outcome }}',
                        who: '${{ steps.ask.outputs.resolverUserId }}',
                    },
                },
            },
        );
        const { store, runner, requests } = setup(decl);
        const events: FactEvent[] = [];
        await runner.subscribeEvents({ onEvent: (e) => events.push(e) });
        runner.registerStepKind('route', async (step) => {
            downstreamParams = (step as { params?: Record<string, unknown> }).params;
            return { kind: 'completed', output: { done: true } };
        });

        const run = await runner.dispatch('wf-convene', {}, userPrincipal('alice', ['rooms:read', 'rooms:post']), {});
        expect(run.status).toBe('awaiting_input');

        // The port saw the full ask payload, defaults applied.
        expect(requests).toHaveLength(1);
        const req = requests[0]!;
        expect(req.room).toEqual({ kind: 'room', roomId: 'room-7' });
        expect(req.title).toBe('Approve the May payout');
        expect(req.brief).toBe('Finance needs a yes or no on the May payout before Friday.');
        expect(req.schema).toEqual(DEFAULT_CONVENE_VALUE_SCHEMA);
        expect(req.resolvers).toBe('any-member');
        expect(req.askToken).toMatch(/^ask:/);
        expect(req.runId).toBe(run.runId);
        expect(req.stepId).toBe('ask');
        expect(req.nudgeAfterSec).toBe(3600);
        expect(req.expireAfterSec).toBe(86400);

        // Durably parked on the signal rail, signalKey === askToken,
        // schema is the resume ENVELOPE (the ask value-schema is the
        // rooms resolve gate's business).
        const parked = await store.getRunState(run.runId);
        expect(parked?.status).toBe('paused');
        const pause = parked!.resume!.paused[0]!;
        expect(pause.kind).toBe('signal');
        expect(pause.signalKey).toBe(req.askToken);
        expect(pause.schema).toEqual(CONVENE_RESUME_ENVELOPE_SCHEMA);
        const pausedEvent = events.find((e) => e.type === 'fact.run_paused_signal');
        expect(pausedEvent?.payload).toMatchObject({ nodeId: 'ask', signalKey: req.askToken });
        // The room timeline is the single ask surface — no legacy HITL
        // render channel fires.
        expect(events.find((e) => e.type === 'fact.run_paused_human')).toBeUndefined();

        // The rooms-side resolve resumes with the typed envelope.
        await runner.resumeRun({
            runId: run.runId,
            promptId: pause.promptId,
            value: {
                outcome: 'resolved',
                value: { decision: 'approve' },
                resolverUserId: 'bob',
                boundVersion: 'v3',
                digestDelta: { changedFiles: 1 },
            },
        });

        expect((await store.getRunState(run.runId))?.status).toBe('completed');
        const askNode = events.find((e) => e.type === 'fact.node_completed' && (e.payload as { nodeId?: string }).nodeId === 'ask');
        expect((askNode!.payload as { output: unknown }).output).toEqual({
            outcome: 'resolved',
            value: { decision: 'approve' },
            resolverUserId: 'bob',
            boundVersion: 'v3',
            digestDelta: { changedFiles: 1 },
        });
        expect(downstreamParams).toEqual({ outcome: 'resolved', who: 'bob' });
    });

    it('passes the workbench descriptor through to the port, defaulting runId to the run', async () => {
        const decl = conveneDecl({
            kind: 'convene',
            room: 'inbox:clement@bitrefill.com',
            title: 'Publish This Week?',
            brief: 'Review the staged edition.',
            workbench: {
                workspaces: ['this-week'],
                paths: ['workspaces/sites/this-week/data/latest.json'],
                verb: 'approve',
                previewKind: 'site',
                preview: { site: 'this-week', path: 'workspaces/sites/this-week/data/latest.json' },
            },
        });
        const { runner, requests } = setup(decl);
        const run = await runner.dispatch('wf-convene', {}, userPrincipal('alice', ['rooms:read']), {});

        expect(requests).toHaveLength(1);
        const wb = requests[0]!.workbench;
        expect(wb).toBeDefined();
        expect(wb!.workspaces).toEqual(['this-week']);
        expect(wb!.verb).toBe('approve');
        expect(wb!.previewKind).toBe('site');
        expect(wb!.paths).toEqual(['workspaces/sites/this-week/data/latest.json']);
        // The engine fills runId from the run when the author omits it.
        expect(wb!.runId).toBe(run.runId);
    });

    it('timeout: the expire path resumes with outcome "timeout" and the run completes', async () => {
        const decl = conveneDecl({
            kind: 'convene',
            room: 'room-7',
            title: 'Sign off',
            brief: 'Quick check.',
            expireAfterSec: 60,
        });
        const { store, runner } = setup(decl);
        const run = await runner.dispatch('wf-convene', {}, userPrincipal('alice', ['rooms:read']), {});
        const pause = (await store.getRunState(run.runId))!.resume!.paused[0]!;

        await runner.resumeRun({
            runId: run.runId,
            promptId: pause.promptId,
            value: { outcome: 'timeout' },
        });

        const final = await store.getRunState(run.runId);
        expect(final?.status).toBe('completed');
    });

    it('rejects a resume value outside the envelope (missing/unknown outcome) and stays parked', async () => {
        const decl = conveneDecl({ kind: 'convene', room: 'room-7', title: 'T', brief: 'B' });
        const { store, runner } = setup(decl);
        const run = await runner.dispatch('wf-convene', {}, userPrincipal('alice', []), {});
        const pause = (await store.getRunState(run.runId))!.resume!.paused[0]!;

        await expect(runner.resumeRun({ runId: run.runId, promptId: pause.promptId, value: { value: 1 } })).rejects.toThrow(
            /HITL value invalid/,
        );
        await expect(runner.resumeRun({ runId: run.runId, promptId: pause.promptId, value: { outcome: 'withdrawn?' } })).rejects.toThrow(
            /HITL value invalid/,
        );
        expect((await store.getRunState(run.runId))?.status).toBe('paused');
    });

    it('solo HITL: inbox:<user-ref> targets the inbox room through the same path', async () => {
        const decl = conveneDecl({
            kind: 'convene',
            room: 'inbox:bob@bitrefill.com',
            title: 'T',
            brief: 'B',
        });
        const { store, runner, requests } = setup(decl);
        const run = await runner.dispatch('wf-convene', {}, userPrincipal('alice', []), {});
        expect(run.status).toBe('awaiting_input');
        expect(requests[0]!.room).toEqual({ kind: 'inbox', user: 'bob@bitrefill.com' });
        expect((await store.getRunState(run.runId))?.status).toBe('paused');
    });

    it('dedupe pass-through: subject rides provenance; a deduped receipt still parks normally', async () => {
        const decl = conveneDecl({
            kind: 'convene',
            room: 'room-7',
            title: 'T',
            brief: 'B',
            subject: 'payout-2026-05',
            resolvers: ['bob', 'carol'],
        });
        const { store, runner, requests } = setup(decl, {
            receipt: { askId: 'ask-existing', deduped: true, boundVersion: 'v9' },
        });
        const run = await runner.dispatch('wf-convene', {}, userPrincipal('alice', []), {});
        expect(run.status).toBe('awaiting_input');
        const req = requests[0]!;
        // `workflow` is deliberately absent — the adapter fills it from
        // the durable run row (it has runId); the step owns `subject`.
        expect(req.provenance).toEqual({ subject: 'payout-2026-05' });
        expect(req.resolvers).toEqual(['bob', 'carol']);
        // Dedupe is the adapter's concern: the engine parks on its own
        // askToken either way (the refreshed ask re-binds to it).
        const parked = await store.getRunState(run.runId);
        expect(parked!.resume!.paused[0]!.signalKey).toBe(req.askToken);
    });

    it('KEYSTONE: the port receives the workflow execution scopes; a scope_denied throw reaches the run error verbatim', async () => {
        const decl = conveneDecl({ kind: 'convene', room: 'room-finance', title: 'T', brief: 'B' });
        const { runner, requests } = setup(decl, {
            fail: new Error('scope_denied: this room needs more authority than the workflow has; missing: rooms:finance'),
        });
        const run = await runner.dispatch('wf-convene', {}, userPrincipal('alice', ['rooms:read', 'rooms:post']), {});

        // The adapter got exactly the principal's effective scope set
        // to enforce the room declaredScopes ⊆ executionScopes gate.
        expect([...requests[0]!.executionScopes].sort()).toEqual(['rooms:post', 'rooms:read']);

        expect(run.status).toBe('errored');
        expect(run.error?.code).toBe('scope_denied');
        expect(run.error?.message).toBe('scope_denied: this room needs more authority than the workflow has; missing: rooms:finance');
    });

    it('service principals contribute an empty executionScopes list', async () => {
        const decl = conveneDecl({ kind: 'convene', room: 'room-7', title: 'T', brief: 'B' });
        const { runner, requests } = setup(decl);
        const run = await runner.dispatch('wf-convene', {}, servicePrincipal('cron-tick', 'req-1'), {});
        expect(run.status).toBe('awaiting_input');
        expect(requests[0]!.executionScopes).toEqual([]);
    });

    it('untagged port failures are flattened (raw server-fault text stays off the run error)', async () => {
        const decl = conveneDecl({ kind: 'convene', room: 'room-7', title: 'T', brief: 'B' });
        const { runner } = setup(decl, { fail: new Error('MongoServerError: E11000 dup key') });
        const run = await runner.dispatch('wf-convene', {}, userPrincipal('alice', []), {});
        expect(run.status).toBe('errored');
        expect(run.error?.code).toBe('convene_failed');
        expect(run.error?.message).not.toMatch(/Mongo/);
    });

    it('invalid room targets fail fast with a tagged invalid_input (no port call, no park)', async () => {
        for (const room of ['', '   ', 'inbox:', 'inbox:   ']) {
            const decl = conveneDecl({ kind: 'convene', room, title: 'T', brief: 'B' });
            const { runner, requests } = setup(decl);
            const run = await runner.dispatch('wf-convene', {}, userPrincipal('alice', []), {});
            expect(run.status).toBe('errored');
            expect(run.error?.code).toBe('invalid_input');
            expect(run.error?.message).toMatch(/^invalid_input: /);
            expect(requests).toHaveLength(0);
        }
    });

    it('survives a restart: a FRESH runner over the same store resumes the convene park', async () => {
        const decl = conveneDecl({ kind: 'convene', room: 'room-7', title: 'T', brief: 'B' });
        const store = new InMemoryStore();
        const { port } = fakePort();

        const runnerA = createRunner({ store });
        runnerA.registerStepKind('convene', makeConveneStepHandler({ port, log: NULL_LOG }));
        runnerA.registerWorkflowReader(readerOf(decl));
        const run = await runnerA.dispatch('wf-convene', {}, userPrincipal('alice', []), {});
        const pause = (await store.getRunState(run.runId))!.resume!.paused[0]!;

        // Process B never registered 'convene' — the parked step is NOT
        // re-run on resume; the seed satisfies it with the envelope.
        const runnerB = createRunner({ store });
        runnerB.registerWorkflowReader(readerOf(decl));
        await runnerB.resumeRun({
            runId: run.runId,
            promptId: pause.promptId,
            value: { outcome: 'resolved', value: { decision: 'decline' }, resolverUserId: 'bob' },
        });
        expect((await store.getRunState(run.runId))?.status).toBe('completed');
    });
});

describe('parseConveneRoomTarget', () => {
    it('parses room ids, inbox refs, and rejects empties', () => {
        expect(parseConveneRoomTarget('room-1')).toEqual({ kind: 'room', roomId: 'room-1' });
        expect(parseConveneRoomTarget(' room-1 ')).toEqual({ kind: 'room', roomId: 'room-1' });
        expect(parseConveneRoomTarget('inbox:bob')).toEqual({ kind: 'inbox', user: 'bob' });
        expect(parseConveneRoomTarget('')).toHaveProperty('error');
        expect(parseConveneRoomTarget('inbox:')).toHaveProperty('error');
        expect(parseConveneRoomTarget(42)).toHaveProperty('error');
    });
});
