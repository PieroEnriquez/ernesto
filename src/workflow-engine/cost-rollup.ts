/**
 * Cost-rollup reducer — aggregates `fact.usage` events into a
 * `RunUsage` projection per run, optionally rolled up over a
 * `surfaceRunId` subtree.
 *
 * The reducer is pure: feed it an iterable of events, get back the
 * accumulated usage. Today: in-memory across an in-flight run.
 * Tomorrow (M3-durable): a projection worker tails the durable
 * event log and persists the accumulated `RunUsage` per
 * `surfaceRunId` so the operator surface can answer "what did this
 * Slack thread cost so far" without scanning every event.
 *
 * The rollup tree comes from `fact.subagent_completed` events whose
 * `subRunId` field links a child run's totals onto the parent.
 *
 * See workspaces/agent-ops/unified-runtime/architecture.md §"Cost rollup".
 */

import type { FactEvent } from './types/event';
import type { RunUsage } from './types/runner';
import { ZERO_USAGE } from './types/runner';

/** Aggregate a sequence of fact events into a `RunUsage`. Mutates
 *  nothing — returns a fresh `RunUsage`. Only the events with
 *  payload-carried usage data contribute; everything else is
 *  ignored. */
export function aggregateUsage(events: Iterable<FactEvent>): RunUsage {
    const agg: RunUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
        durationMs: 0,
        modelUsage: {},
        childRuns: [],
    };
    let startedAt: number | undefined;
    let endedAt: number | undefined;

    for (const ev of events) {
        if (ev.type === 'fact.run_started') {
            if (startedAt === undefined || ev.ts < startedAt) startedAt = ev.ts;
        }
        if (ev.type === 'fact.run_terminated') {
            if (endedAt === undefined || ev.ts > endedAt) endedAt = ev.ts;
        }
        if (ev.type !== 'fact.usage') continue;
        const p = ev.payload as {
            inputTokens?: number;
            outputTokens?: number;
            cacheRead?: number;
            cacheWrite?: number;
            costUsd?: number;
            modelUsage?: Record<
                string,
                { inputTokens?: number; outputTokens?: number; costUsd?: number }
            >;
        };
        if (typeof p.inputTokens === 'number') agg.inputTokens += p.inputTokens;
        if (typeof p.outputTokens === 'number') agg.outputTokens += p.outputTokens;
        if (typeof p.cacheRead === 'number') agg.cacheRead += p.cacheRead;
        if (typeof p.cacheWrite === 'number') agg.cacheWrite += p.cacheWrite;
        if (typeof p.costUsd === 'number') agg.costUsd += p.costUsd;
        if (p.modelUsage) {
            for (const [model, line] of Object.entries(p.modelUsage)) {
                const existing = agg.modelUsage[model] ?? {
                    inputTokens: 0,
                    outputTokens: 0,
                };
                existing.inputTokens += line.inputTokens ?? 0;
                existing.outputTokens += line.outputTokens ?? 0;
                if (line.costUsd !== undefined) {
                    existing.costUsd = (existing.costUsd ?? 0) + line.costUsd;
                }
                agg.modelUsage[model] = existing;
            }
        }
    }

    if (startedAt !== undefined && endedAt !== undefined) {
        agg.durationMs = Math.max(0, endedAt - startedAt);
    }
    return agg;
}

/** Build a recursive `RunUsage` rollup: for each `surfaceRunId`,
 *  aggregate all events whose `surfaceRunId` matches, optionally
 *  attaching child-run subtotals from `fact.subagent_completed`
 *  references.
 *
 *  Events should be sorted by `(runId, seq)` for deterministic
 *  attribution; the helper does not sort.
 *
 *  Today this builds a flat aggregation (childRuns array stays
 *  empty unless subagent_completed events carry usage). M3 will
 *  add the durable cross-run linkage so a Slack-thread surface's
 *  total includes every recursive child's totals. */
export function rollupBySurface(
    events: Iterable<FactEvent>,
    surfaceRunId: string,
): RunUsage {
    const eventsArr = [...events];
    const matching = eventsArr.filter((e) => {
        const sr = (e.routing as { surfaceRunId?: string } | undefined)?.surfaceRunId;
        return sr === surfaceRunId || e.runId === surfaceRunId;
    });
    const own = aggregateUsage(matching);

    // Collect child run ids via subagent_completed
    const childRunIds = new Set<string>();
    for (const e of matching) {
        if (e.type === 'fact.subagent_completed') {
            const p = e.payload as { subRunId?: string };
            if (p.subRunId) childRunIds.add(p.subRunId);
        }
    }
    const childRuns: RunUsage['childRuns'] = [];
    for (const childRunId of childRunIds) {
        const childEvents = eventsArr.filter((e) => e.runId === childRunId);
        if (childEvents.length === 0) continue;
        const childUsage = aggregateUsage(childEvents);
        childRuns.push({ runId: childRunId, usage: childUsage });
        own.inputTokens += childUsage.inputTokens;
        own.outputTokens += childUsage.outputTokens;
        own.cacheRead += childUsage.cacheRead;
        own.cacheWrite += childUsage.cacheWrite;
        own.costUsd += childUsage.costUsd;
        for (const [model, line] of Object.entries(childUsage.modelUsage)) {
            const ex = own.modelUsage[model] ?? { inputTokens: 0, outputTokens: 0 };
            ex.inputTokens += line.inputTokens;
            ex.outputTokens += line.outputTokens;
            if (line.costUsd !== undefined) {
                ex.costUsd = (ex.costUsd ?? 0) + line.costUsd;
            }
            own.modelUsage[model] = ex;
        }
    }
    own.childRuns = childRuns;
    return own;
}

export { ZERO_USAGE };
