/**
 * Tests for the renderer-facing conversation-state primitive.
 *
 * Covers the file read/write round-trip, the no-prior-state path
 * (renderers handle "first turn ever" cleanly), and the
 * `decideRendererAction` pure helper that encodes the state machine
 * so per-tier renderers don't duplicate it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
    CONVERSATION_STATE_VERSION,
    UI_TRAIL_CAP,
    appendHitlToTrail,
    appendUiTrail,
    composeStrategy,
    decideRendererAction,
    defaultRendererStrategy,
    loadConversationState,
    saveConversationState,
    updateConversationState,
    type ConversationState,
    type RendererInput,
    type RendererPromptStrategy,
    type UiTrailEntry,
} from '../conversation-state';
import type { HitlComponent } from '../../components/types';

describe('conversation-state', () => {
    let workdir: string;

    beforeEach(async () => {
        workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'convstate-'));
    });

    afterEach(async () => {
        await fs.rm(workdir, { recursive: true, force: true });
    });

    it('loadConversationState returns undefined when file is absent', async () => {
        expect(await loadConversationState(workdir)).toBeUndefined();
    });

    it('round-trips a state through save + load (incl. sessionId)', async () => {
        const state: ConversationState = {
            version: CONVERSATION_STATE_VERSION,
            status: 'awaiting_input',
            activeRunId: 'run-1',
            sessionId: 'c271e1aa-ca3c-40fa-be00-93141c38abcd',
            lastTransitionAt: 1700000000000,
            pendingHitl: {
                runId: 'run-1',
                promptId: 'p-1',
                expect: { kind: 'choice', schema: { enum: ['yes', 'no'] } },
                resumePrompt: 'User chose {value}.',
                render: [{ kind: 'markdown', props: { body: 'Approve?' } }],
            },
        };
        await saveConversationState(workdir, state);
        const loaded = await loadConversationState(workdir);
        expect(loaded).toEqual(state);
    });

    it('save is atomic — no .tmp leftover after success', async () => {
        await saveConversationState(workdir, {
            version: CONVERSATION_STATE_VERSION,
            status: 'completed',
            lastTransitionAt: Date.now(),
        });
        const entries = await fs.readdir(path.join(workdir, '.ernesto'));
        expect(entries).toEqual(['state.json']);
    });

    it('updateConversationState fabricates a baseline when no prior file exists', async () => {
        const result = await updateConversationState(workdir, (prev) => ({
            ...prev,
            status: 'running',
            activeRunId: 'run-X',
        }));
        expect(result.status).toBe('running');
        expect(result.activeRunId).toBe('run-X');
        expect(result.lastTransitionAt).toBeGreaterThan(0);
    });

    it('updateConversationState preserves unrelated fields across mutates', async () => {
        await updateConversationState(workdir, (prev) => ({
            ...prev,
            status: 'awaiting_input',
            activeRunId: 'run-1',
            pendingHitl: {
                runId: 'run-1',
                promptId: 'p-1',
                expect: { kind: 'message' },
                resumePrompt: '',
                render: [],
            },
        }));
        await updateConversationState(workdir, (prev) => ({
            ...prev,
            status: 'completed',
            pendingHitl: undefined,
        }));
        const loaded = await loadConversationState(workdir);
        expect(loaded?.status).toBe('completed');
        expect(loaded?.activeRunId).toBe('run-1');
        expect(loaded?.pendingHitl).toBeUndefined();
    });

    it('loadConversationState returns undefined for malformed JSON', async () => {
        await fs.mkdir(path.join(workdir, '.ernesto'), { recursive: true });
        await fs.writeFile(
            path.join(workdir, '.ernesto', 'state.json'),
            '{not json',
            'utf8',
        );
        expect(await loadConversationState(workdir)).toBeUndefined();
    });
});

describe('decideRendererAction (strategy-driven)', () => {
    const newMsg: RendererInput = { kind: 'new_message', text: 'hello' };
    const SID = 'session-uuid-X';

    it('dispatch_new with strategy.forNew when no prior state', () => {
        const action = decideRendererAction(undefined, newMsg);
        expect(action).toEqual({
            kind: 'dispatch_new',
            prompt: 'hello',
            reason: 'no_prior_state',
        });
    });

    it('dispatch_new when status is "new"', () => {
        expect(
            decideRendererAction(
                {
                    version: CONVERSATION_STATE_VERSION,
                    status: 'new',
                    lastTransitionAt: 0,
                },
                newMsg,
            ),
        ).toMatchObject({ kind: 'dispatch_new', reason: 'no_prior_state' });
    });

    it('preempts a running run + materializes the strategy hook', () => {
        const action = decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'running',
                activeRunId: 'run-1',
                sessionId: SID,
                lastTransitionAt: 0,
            },
            { kind: 'new_message', text: 'wait, change of plans' },
        );
        expect(action.kind).toBe('abort_then_continuation');
        if (action.kind === 'abort_then_continuation') {
            expect(action.abortRunId).toBe('run-1');
            expect(action.resumeSessionId).toBe(SID);
            expect(action.prompt).toContain('interrupted');
            expect(action.prompt).toContain('wait, change of plans');
        }
    });

    it('preempts an awaiting_input run when the user sends a fresh message', () => {
        const action = decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'awaiting_input',
                activeRunId: 'run-1',
                sessionId: SID,
                lastTransitionAt: 0,
                pendingHitl: {
                    runId: 'run-1',
                    promptId: 'p-1',
                    expect: { kind: 'message' },
                    resumePrompt: '',
                    render: [
                        { kind: 'markdown', props: { body: 'Approve change?' } },
                    ],
                },
            },
            { kind: 'new_message', text: 'forget it, do X instead' },
        );
        expect(action.kind).toBe('abort_then_continuation');
        if (action.kind === 'abort_then_continuation') {
            expect(action.abortRunId).toBe('run-1');
            expect(action.resumeSessionId).toBe(SID);
            expect(action.prompt).toContain('forget it, do X instead');
        }
    });

    it('resolves a HITL response that matches the pending promptId', () => {
        const action = decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'awaiting_input',
                activeRunId: 'run-1',
                sessionId: SID,
                lastTransitionAt: 0,
                pendingHitl: {
                    runId: 'run-1',
                    promptId: 'p-1',
                    expect: {
                        kind: 'choice',
                        schema: { enum: ['approve', 'reject'] },
                    },
                    resumePrompt: 'User chose {value}. Proceed.',
                    render: [{ kind: 'markdown', props: { body: 'Approve?' } }],
                },
            },
            { kind: 'hitl_response', promptId: 'p-1', value: 'approve' },
        );
        expect(action).toEqual({
            kind: 'dispatch_continuation',
            prompt: 'User chose approve. Proceed.',
            resumeSessionId: SID,
            reason: 'hitl_resolved',
        });
    });

    it('treats a HITL response with a stale promptId as a new-message', () => {
        const action = decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'completed',
                sessionId: SID,
                lastTransitionAt: 0,
            },
            { kind: 'hitl_response', promptId: 'stale', value: 'approve' },
        );
        // Stale → renderer-default `forCompleted` (pass-through).
        expect(action).toEqual({
            kind: 'dispatch_continuation',
            prompt: 'approve',
            resumeSessionId: SID,
            reason: 'completed',
        });
    });

    it.each(['completed', 'errored', 'canceled'] as const)(
        'clean continuation when status is %s (resumeSessionId carried)',
        (status) => {
            const action = decideRendererAction(
                {
                    version: CONVERSATION_STATE_VERSION,
                    status,
                    sessionId: SID,
                    lastTransitionAt: 0,
                    ...(status === 'errored'
                        ? { lastError: { code: 'X', message: 'boom' } }
                        : {}),
                },
                { kind: 'new_message', text: 'try again' },
            );
            expect(action.kind).toBe('dispatch_continuation');
            if (action.kind === 'dispatch_continuation') {
                expect(action.resumeSessionId).toBe(SID);
                expect(action.reason).toBe(status);
                expect(action.prompt).toContain('try again');
                if (status === 'errored') {
                    expect(action.prompt).toContain('boom');
                }
            }
        },
    );

    it('renderer strategy hooks compose with lib defaults', () => {
        const slackish: RendererPromptStrategy = {
            forNew: (input) => `<runtime>ch=${input.metadata?.channel}</runtime>\n\n${input.text}`,
        };
        const action = decideRendererAction(
            undefined,
            {
                kind: 'new_message',
                text: 'hello',
                metadata: { channel: 'C1' },
            },
            slackish,
        );
        expect(action.kind).toBe('dispatch_new');
        if (action.kind === 'dispatch_new') {
            expect(action.prompt).toBe('<runtime>ch=C1</runtime>\n\nhello');
        }
    });
});

describe('composeStrategy', () => {
    it('returns the default strategy as-is when nothing is provided', () => {
        expect(composeStrategy(undefined)).toBe(defaultRendererStrategy);
    });

    it('overlays custom hooks on top of the defaults', () => {
        const custom: RendererPromptStrategy = {
            forCanceled: (input) => `[custom cancel] ${input.text}`,
        };
        const composed = composeStrategy(custom);
        expect(
            composed.forCanceled({ kind: 'new_message', text: 'retry' }, {}),
        ).toBe('[custom cancel] retry');
        // unrelated hook still falls back to default
        expect(
            composed.forNew({ kind: 'new_message', text: 'hi' }),
        ).toBe('hi');
    });
});

describe('appendHitlToTrail', () => {
    let workdir: string;

    beforeEach(async () => {
        workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'uitrail-'));
    });

    afterEach(async () => {
        await fs.rm(workdir, { recursive: true, force: true });
    });

    function hitl(i: number): HitlComponent {
        return {
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: `m${i}` } }],
                expect: { kind: 'message' },
                resumePrompt: '',
            },
        };
    }

    it('round-trips a single hitl entry', async () => {
        await appendHitlToTrail(workdir, 'run-1', hitl(1));
        const loaded = await loadConversationState(workdir);
        expect(loaded?.uiTrail).toHaveLength(1);
        expect(loaded?.uiTrail?.[0]?.runId).toBe('run-1');
        expect(loaded?.uiTrail?.[0]?.hitl).toEqual(hitl(1));
        expect(typeof loaded?.uiTrail?.[0]?.ts).toBe('number');
    });

    it('appends across multiple invocations in order', async () => {
        await appendHitlToTrail(workdir, 'run-1', hitl(1));
        await appendHitlToTrail(workdir, 'run-2', hitl(2));
        await appendHitlToTrail(workdir, 'run-3', hitl(3));
        const loaded = await loadConversationState(workdir);
        expect(loaded?.uiTrail).toHaveLength(3);
        expect(loaded?.uiTrail?.map((e) => e.runId)).toEqual([
            'run-1',
            'run-2',
            'run-3',
        ]);
    });

    it('honors the rolling cap — 51st entry drops the oldest', async () => {
        for (let i = 0; i < UI_TRAIL_CAP + 1; i++) {
            await appendHitlToTrail(workdir, `run-${i}`, hitl(i));
        }
        const loaded = await loadConversationState(workdir);
        expect(loaded?.uiTrail).toHaveLength(UI_TRAIL_CAP);
        expect(loaded?.uiTrail?.[0]?.runId).toBe('run-1');
        expect(loaded?.uiTrail?.[UI_TRAIL_CAP - 1]?.runId).toBe(
            `run-${UI_TRAIL_CAP}`,
        );
    });

    it('writes atomically — no .tmp leftover', async () => {
        await appendHitlToTrail(workdir, 'run-1', hitl(1));
        const entries = await fs.readdir(path.join(workdir, '.ernesto'));
        expect(entries).toEqual(['state.json']);
    });

    it('preserves unrelated state fields', async () => {
        await updateConversationState(workdir, (prev) => ({
            ...prev,
            status: 'running',
            activeRunId: 'run-X',
            sessionId: 'sid-1',
        }));
        await appendHitlToTrail(workdir, 'run-7', hitl(7));
        const loaded = await loadConversationState(workdir);
        expect(loaded?.status).toBe('running');
        expect(loaded?.activeRunId).toBe('run-X');
        expect(loaded?.sessionId).toBe('sid-1');
        expect(loaded?.uiTrail).toHaveLength(1);
        expect(loaded?.uiTrail?.[0]?.hitl).toEqual(hitl(7));
    });
});

describe('appendUiTrail (deprecated)', () => {
    let workdir: string;

    beforeEach(async () => {
        workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'uitrail-dep-'));
    });

    afterEach(async () => {
        await fs.rm(workdir, { recursive: true, force: true });
    });

    it('routes a hitl component through to the trail', async () => {
        const h: HitlComponent = {
            kind: 'hitl',
            props: {
                render: [{ kind: 'markdown', props: { body: 'Q?' } }],
                expect: { kind: 'message' },
                resumePrompt: '',
            },
        };
        await appendUiTrail(workdir, {
            ts: 1,
            runId: 'run-1',
            component: h,
        } as any);
        const loaded = await loadConversationState(workdir);
        expect(loaded?.uiTrail).toHaveLength(1);
        expect(loaded?.uiTrail?.[0]?.hitl).toEqual(h);
    });

    it('no-ops for non-hitl components', async () => {
        await appendUiTrail(workdir, {
            ts: 1,
            runId: 'run-1',
            component: { kind: 'status', props: { text: 'x' } },
        } as any);
        await appendUiTrail(workdir, {
            ts: 2,
            runId: 'run-1',
            component: { kind: 'markdown', props: { body: 'plain' } },
        } as any);
        const loaded = await loadConversationState(workdir);
        // No-ops never created a state file.
        expect(loaded).toBeUndefined();
    });
});

describe('decideRendererAction — prev.uiTrail threading', () => {
    const SID = 'session-uuid-Y';
    const trail: UiTrailEntry[] = [
        {
            ts: 1,
            runId: 'r-prior',
            hitl: {
                kind: 'hitl',
                props: {
                    render: [
                        { kind: 'markdown', props: { body: 'first answer' } },
                    ],
                    expect: { kind: 'message' },
                    resumePrompt: '',
                },
            },
        },
    ];

    it('passes prev.uiTrail into forCompleted', () => {
        const seen: { uiTrail?: UiTrailEntry[] }[] = [];
        const strategy: RendererPromptStrategy = {
            forCompleted: (input, prev) => {
                seen.push(prev);
                return input.text;
            },
        };
        decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'completed',
                sessionId: SID,
                lastTransitionAt: 0,
                uiTrail: trail,
            },
            { kind: 'new_message', text: 'next' },
            strategy,
        );
        expect(seen).toHaveLength(1);
        expect(seen[0]?.uiTrail).toEqual(trail);
    });

    it('passes prev.uiTrail into forRunningPreempted', () => {
        const seen: { uiTrail?: UiTrailEntry[] }[] = [];
        const strategy: RendererPromptStrategy = {
            forRunningPreempted: (input, prev) => {
                seen.push(prev);
                return input.text;
            },
        };
        decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'running',
                activeRunId: 'run-1',
                sessionId: SID,
                lastTransitionAt: 0,
                uiTrail: trail,
            },
            { kind: 'new_message', text: 'change plans' },
            strategy,
        );
        expect(seen[0]?.uiTrail).toEqual(trail);
    });

    it('passes prev.uiTrail into forErrored / forCanceled / forAwaitingInputPreempted', () => {
        const calls: Record<string, UiTrailEntry[] | undefined> = {};
        const strategy: RendererPromptStrategy = {
            forErrored: (input, _error, prev) => {
                calls.errored = prev.uiTrail;
                return input.text;
            },
            forCanceled: (input, prev) => {
                calls.canceled = prev.uiTrail;
                return input.text;
            },
            forAwaitingInputPreempted: (input, _pending, prev) => {
                calls.aip = prev.uiTrail;
                return input.text;
            },
        };
        decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'errored',
                sessionId: SID,
                lastTransitionAt: 0,
                lastError: { code: 'E', message: 'oops' },
                uiTrail: trail,
            },
            { kind: 'new_message', text: 'again' },
            strategy,
        );
        decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'canceled',
                sessionId: SID,
                lastTransitionAt: 0,
                uiTrail: trail,
            },
            { kind: 'new_message', text: 'again' },
            strategy,
        );
        decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'awaiting_input',
                sessionId: SID,
                lastTransitionAt: 0,
                pendingHitl: {
                    runId: 'r',
                    promptId: 'p',
                    expect: { kind: 'message' },
                    resumePrompt: '',
                    render: [],
                },
                uiTrail: trail,
            },
            { kind: 'new_message', text: 'forget it' },
            strategy,
        );
        expect(calls.errored).toEqual(trail);
        expect(calls.canceled).toEqual(trail);
        expect(calls.aip).toEqual(trail);
    });

    it('passes empty prev when state has no uiTrail', () => {
        let receivedPrev: { uiTrail?: UiTrailEntry[] } | undefined;
        const strategy: RendererPromptStrategy = {
            forCompleted: (input, prev) => {
                receivedPrev = prev;
                return input.text;
            },
        };
        decideRendererAction(
            {
                version: CONVERSATION_STATE_VERSION,
                status: 'completed',
                sessionId: SID,
                lastTransitionAt: 0,
            },
            { kind: 'new_message', text: 'hi' },
            strategy,
        );
        expect(receivedPrev).toBeDefined();
        expect(receivedPrev?.uiTrail).toBeUndefined();
    });
});
