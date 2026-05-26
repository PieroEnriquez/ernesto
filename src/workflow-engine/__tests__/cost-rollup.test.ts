/**
 * Cost-rollup reducer tests.
 *
 * Exercises:
 *   - aggregateUsage: sums per-event usage counts + per-model breakdown
 *   - duration computed from run_started → run_terminated
 *   - rollupBySurface: aggregates events by surfaceRunId
 *   - childRuns: subagent_completed links add child usage to parent
 */

import { describe, it, expect } from 'vitest';
import { aggregateUsage, rollupBySurface } from '../cost-rollup';
import type { FactEvent } from '../types/event';

function event(
    type: string,
    runId: string,
    payload: Record<string, unknown>,
    ts: number,
    routing?: Record<string, unknown>,
): FactEvent {
    const ev: FactEvent = { runId, seq: 0, type, payload, ts };
    if (routing) (ev as { routing?: unknown }).routing = routing;
    return ev;
}

describe('aggregateUsage', () => {
    it('sums tokens + cost across multiple usage events', () => {
        const events: FactEvent[] = [
            event('fact.run_started', 'r1', { workflow: 'w' }, 1000),
            event(
                'fact.usage',
                'r1',
                { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
                1100,
            ),
            event(
                'fact.usage',
                'r1',
                { inputTokens: 200, outputTokens: 75, costUsd: 0.02 },
                1200,
            ),
            event('fact.run_terminated', 'r1', { status: 'completed' }, 1300),
        ];
        const usage = aggregateUsage(events);
        expect(usage.inputTokens).toBe(300);
        expect(usage.outputTokens).toBe(125);
        expect(usage.costUsd).toBeCloseTo(0.03, 5);
        expect(usage.durationMs).toBe(300);
    });

    it('rolls up per-model usage line items', () => {
        const events: FactEvent[] = [
            event(
                'fact.usage',
                'r1',
                {
                    inputTokens: 100,
                    outputTokens: 50,
                    costUsd: 0.01,
                    modelUsage: {
                        'claude-sonnet-4-6': { inputTokens: 60, outputTokens: 30, costUsd: 0.006 },
                        'kimi-k2.6': { inputTokens: 40, outputTokens: 20, costUsd: 0.004 },
                    },
                },
                1000,
            ),
            event(
                'fact.usage',
                'r1',
                {
                    inputTokens: 50,
                    outputTokens: 25,
                    modelUsage: {
                        'claude-sonnet-4-6': { inputTokens: 50, outputTokens: 25, costUsd: 0.005 },
                    },
                },
                1100,
            ),
        ];
        const usage = aggregateUsage(events);
        expect(usage.modelUsage['claude-sonnet-4-6']).toEqual({
            inputTokens: 110,
            outputTokens: 55,
            costUsd: expect.closeTo(0.011, 5) as unknown as number,
        });
        expect(usage.modelUsage['kimi-k2.6']).toEqual({
            inputTokens: 40,
            outputTokens: 20,
            costUsd: 0.004,
        });
    });

    it('accumulates cache hits separately from input/output tokens', () => {
        const events: FactEvent[] = [
            event(
                'fact.usage',
                'r1',
                {
                    inputTokens: 100,
                    outputTokens: 50,
                    cacheRead: 1000,
                    cacheWrite: 200,
                },
                1000,
            ),
        ];
        const usage = aggregateUsage(events);
        expect(usage.cacheRead).toBe(1000);
        expect(usage.cacheWrite).toBe(200);
        expect(usage.inputTokens).toBe(100);
    });

    it('ignores non-usage events', () => {
        const events: FactEvent[] = [
            event('fact.run_started', 'r1', {}, 1000),
            event('fact.assistant_delta', 'r1', { stepId: 's1', text: 'hi' }, 1100),
            event('fact.tool_call', 'r1', { stepId: 's1', name: 'Read', input: {} }, 1200),
            event('fact.run_terminated', 'r1', { status: 'completed' }, 1300),
        ];
        const usage = aggregateUsage(events);
        expect(usage.inputTokens).toBe(0);
        expect(usage.outputTokens).toBe(0);
        expect(usage.durationMs).toBe(300);
    });

    it('returns zero usage for empty event sequence', () => {
        const usage = aggregateUsage([]);
        expect(usage.inputTokens).toBe(0);
        expect(usage.durationMs).toBe(0);
        expect(usage.modelUsage).toEqual({});
        expect(usage.childRuns).toEqual([]);
    });
});

describe('rollupBySurface', () => {
    it('aggregates events matching surfaceRunId in routing', () => {
        const events: FactEvent[] = [
            event(
                'fact.run_started',
                'r1',
                { workflow: 'w' },
                1000,
                { surfaceRunId: 'surface-1' },
            ),
            event(
                'fact.usage',
                'r1',
                { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
                1100,
                { surfaceRunId: 'surface-1' },
            ),
            // Event from a different surface — must NOT be included
            event(
                'fact.usage',
                'r2',
                { inputTokens: 999, outputTokens: 999 },
                1100,
                { surfaceRunId: 'surface-other' },
            ),
            event(
                'fact.run_terminated',
                'r1',
                { status: 'completed' },
                1300,
                { surfaceRunId: 'surface-1' },
            ),
        ];
        const rollup = rollupBySurface(events, 'surface-1');
        expect(rollup.inputTokens).toBe(100);
        expect(rollup.outputTokens).toBe(50);
        expect(rollup.durationMs).toBe(300);
    });

    it('rolls child runs (via subagent_completed) into the parent surface total', () => {
        const events: FactEvent[] = [
            // Parent run on surface-1
            event(
                'fact.run_started',
                'r-parent',
                {},
                1000,
                { surfaceRunId: 'surface-1' },
            ),
            event(
                'fact.usage',
                'r-parent',
                { inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
                1100,
                { surfaceRunId: 'surface-1' },
            ),
            event(
                'fact.subagent_started',
                'r-parent',
                { stepId: 's1', slug: 'translate', subRunId: 'r-child' },
                1150,
                { surfaceRunId: 'surface-1' },
            ),
            // Child run — events tagged with their own runId (r-child)
            event(
                'fact.run_started',
                'r-child',
                {},
                1160,
            ),
            event(
                'fact.usage',
                'r-child',
                { inputTokens: 50, outputTokens: 25, costUsd: 0.005 },
                1170,
            ),
            event(
                'fact.run_terminated',
                'r-child',
                { status: 'completed' },
                1180,
            ),
            event(
                'fact.subagent_completed',
                'r-parent',
                { stepId: 's1', slug: 'translate', subRunId: 'r-child', result: {} },
                1190,
                { surfaceRunId: 'surface-1' },
            ),
            event(
                'fact.run_terminated',
                'r-parent',
                { status: 'completed' },
                1300,
                { surfaceRunId: 'surface-1' },
            ),
        ];
        const rollup = rollupBySurface(events, 'surface-1');
        // Parent's own input/output tokens + child's
        expect(rollup.inputTokens).toBe(150);
        expect(rollup.outputTokens).toBe(75);
        expect(rollup.costUsd).toBeCloseTo(0.015, 5);
        expect(rollup.childRuns).toHaveLength(1);
        expect(rollup.childRuns[0]!.runId).toBe('r-child');
        expect(rollup.childRuns[0]!.usage.inputTokens).toBe(50);
    });

    it('returns zero when no events match the surface', () => {
        const events: FactEvent[] = [
            event('fact.usage', 'r1', { inputTokens: 999 }, 1000, {
                surfaceRunId: 'other',
            }),
        ];
        const rollup = rollupBySurface(events, 'missing');
        expect(rollup.inputTokens).toBe(0);
        expect(rollup.childRuns).toEqual([]);
    });
});
