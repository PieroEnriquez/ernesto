/**
 * Top-level runner — the implementation of `WorkflowRunner`.
 *
 * One entry point: `dispatch(kind, inputs, principal, opts) → Run<T>`.
 * Wires the event bus, the kind handler dispatcher, the store, and
 * the HITL controller. Mints runIds, resolves declarations via the
 * registered `WorkflowReader`, hands off to the walker, projects the
 * walker's terminal `WalkResult` into a consumer-facing `Run<TOut>`.
 *
 * Clean cut from the prior `dispatchWorkflow({slug, principal:{userId,
 * scopes}, context, ...})` shape. No legacy translation; the runner
 * speaks `Principal` + `DispatchOpts` natively.
 */

import { randomUUID } from 'node:crypto';
import type { StepKind } from '../workflows/types';
import type { StepKindHandler, EngineLogger } from './types/handler';
import type { FactEvent } from './types/event';
import type {
    DispatchOpts,
    EventSubscription,
    KindRef,
    ResumeRunInput,
    Run,
    RunHandleStatus,
    RunUsage,
    SubscribeEventsOpts,
    WorkflowRunner,
} from './types/runner';
import { ZERO_USAGE } from './types/runner';
import type { WorkflowReader } from './workflow-reader';
import type { StorePort } from './store/port';
import type { Principal } from './principal';
import { EventBus } from './event-bus';
import { HandlerDispatcher } from './dispatch';
import { InMemoryStore } from './store/in-memory-store';
import { HitlController, type HitlPauseInput } from './hitl';
import { walk, type WalkResult } from './engine/walker';
import { makeParallelHandler } from './engine/parallel-handler';
import { makeOrchestrationHandler } from './engine/orchestration-handler';

const NULL_LOG: EngineLogger = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
};

export interface CreateRunnerOpts {
    stepKindHandlers?: Map<string, StepKindHandler>;
    workflowReader?: WorkflowReader;
    store?: StorePort;
    log?: EngineLogger;
}

class Runner implements WorkflowRunner {
    private readonly bus = new EventBus();
    private readonly dispatcher = new HandlerDispatcher();
    private readonly store: StorePort;
    private readonly log: EngineLogger;
    private reader: WorkflowReader | undefined;

    // Per-run seq allocators. The store also tracks event seqs but
    // the bus needs a synchronous counter so `pauseForHuman` can emit
    // events without round-tripping through an async append.
    private readonly seqByRun = new Map<string, number>();
    private readonly inflightAborts = new Map<string, AbortController>();
    private readonly hitl: HitlController;

    constructor(opts: CreateRunnerOpts = {}) {
        this.store = opts.store ?? new InMemoryStore();
        this.log = opts.log ?? NULL_LOG;
        if (opts.workflowReader) this.reader = opts.workflowReader;
        if (opts.stepKindHandlers) {
            for (const [kind, handler] of opts.stepKindHandlers.entries()) {
                this.dispatcher.register(kind as StepKind, handler);
            }
        }
        // `parallel` + `orchestration` compose other kinds via the
        // dispatcher, so they're engine primitives — auto-registered
        // regardless of which tier-specific handlers the caller
        // wires. Skip if the caller supplied an override via
        // `stepKindHandlers`.
        if (!this.dispatcher.has('parallel')) {
            this.dispatcher.register('parallel', makeParallelHandler(this.dispatcher));
        }
        if (!this.dispatcher.has('orchestration')) {
            this.dispatcher.register(
                'orchestration',
                makeOrchestrationHandler(this.dispatcher),
            );
        }
        this.hitl = new HitlController(this.bus, this.store, (runId) =>
            this.nextSeq(runId),
        );
    }

    registerStepKind(
        kind: StepKind,
        handler: StepKindHandler<any>,
    ): void {
        this.dispatcher.register(kind, handler);
    }

    registerWorkflowReader(reader: WorkflowReader): void {
        this.reader = reader;
    }

    async subscribeEvents(
        opts: SubscribeEventsOpts,
    ): Promise<EventSubscription> {
        return this.bus.subscribe(opts);
    }

    emitFactEvent(raw: FactEvent): void {
        this.bus.emit(raw);
    }

    async dispatch<TOut = Record<string, unknown>>(
        kind: KindRef,
        inputs: Record<string, unknown>,
        principal: Principal,
        opts: DispatchOpts = {},
    ): Promise<Run<TOut>> {
        if (!this.reader) {
            throw new Error('no workflow reader registered');
        }
        const detail = await this.reader.read(kind);
        if (!detail) {
            throw new Error(`workflow not found: ${kind}`);
        }
        const runId =
            opts.preallocatedRunId ?? `run-${kind}-${randomUUID()}`;
        this.seqByRun.set(runId, 0);

        // Tie the run to an abort controller. If the caller passed a
        // signal, chain to it; otherwise we own a fresh one so
        // `abortRun` can land.
        const ac = new AbortController();
        if (opts.abortSignal) {
            if (opts.abortSignal.aborted) ac.abort();
            else opts.abortSignal.addEventListener('abort', () => ac.abort());
        }
        this.inflightAborts.set(runId, ac);

        const startedAt = Date.now();
        const surfaceRunId = opts.surfaceRunId ?? runId;

        let walkResult: WalkResult;
        try {
            walkResult = await walk(
                runId,
                detail.declaration,
                {
                    kind,
                    inputs,
                    principal,
                    opts: { ...opts, abortSignal: ac.signal },
                },
                {
                    bus: this.bus,
                    dispatcher: this.dispatcher,
                    store: this.store,
                    hitl: this.hitl,
                    log: this.log,
                    nextSeq: (id) => this.nextSeq(id),
                },
            );
        } finally {
            this.inflightAborts.delete(runId);
        }

        return projectRunHandle<TOut>(
            walkResult,
            surfaceRunId,
            startedAt,
            (filterRunId) => this.subscribeRunEvents(filterRunId),
        );
    }

    async resumeRun(input: ResumeRunInput): Promise<void> {
        await this.hitl.resume(input.runId, {
            promptId: input.promptId,
            value: input.value,
        });
    }

    pauseForHuman(input: HitlPauseInput): Promise<unknown> {
        return this.hitl.pauseForHuman(input);
    }

    async abortRun(runId: string): Promise<void> {
        const ac = this.inflightAborts.get(runId);
        if (ac) ac.abort();
        // Wake any HITL pause for this run so the walker's loop falls
        // through to the abort branch on next tick.
        this.hitl.abortPending(runId, 'run aborted');
        const state = await this.store.getRunState(runId);
        if (state && state.status !== 'completed' && state.status !== 'errored') {
            await this.store.putRunState({
                ...state,
                status: 'aborted',
                endedAt: Date.now(),
            });
        }
    }

    private nextSeq(runId: string): number {
        const next = (this.seqByRun.get(runId) ?? 0);
        this.seqByRun.set(runId, next + 1);
        return next;
    }

    /** Build an AsyncIterable yielding fact events for `runId`.
     *  Used by `Run<T>.events()` consumers — subscribers attached
     *  after terminal will only see events that arrive post-attach
     *  (M3 adds replay from store). */
    private subscribeRunEvents(runId: string): AsyncIterable<FactEvent> {
        const bus = this.bus;
        return {
            [Symbol.asyncIterator]: async function* () {
                const queue: FactEvent[] = [];
                const wakers: Array<() => void> = [];
                let closed = false;
                const wakeAll = () => {
                    while (wakers.length) wakers.shift()!();
                };
                const subscription = await bus.subscribe({
                    onEvent: (ev) => {
                        if (ev.runId !== runId) return;
                        queue.push(ev);
                        if (ev.type === 'fact.run_terminated') closed = true;
                        wakeAll();
                    },
                    onError: () => {
                        closed = true;
                        wakeAll();
                    },
                });
                try {
                    while (true) {
                        while (queue.length) yield queue.shift()!;
                        if (closed) break;
                        await new Promise<void>((resolve) =>
                            wakers.push(resolve),
                        );
                    }
                    while (queue.length) yield queue.shift()!;
                } finally {
                    await subscription.close().catch(() => undefined);
                }
            },
        };
    }
}

export function createRunner(opts: CreateRunnerOpts = {}): WorkflowRunner {
    return new Runner(opts);
}

/** Project the walker's terminal `WalkResult` into the consumer-
 *  facing `Run<TOut>` handle. The runner mints the `surfaceRunId`
 *  (defaulting to runId) and the events iterator factory; `output`
 *  is typed via the caller's generic. */
function projectRunHandle<TOut>(
    result: WalkResult,
    surfaceRunId: string,
    startedAt: number,
    eventsFactory: (runId: string) => AsyncIterable<FactEvent>,
): Run<TOut> {
    const durationMs = Date.now() - startedAt;
    const status = mapWalkStatus(result.status);
    const output =
        result.status === 'completed'
            ? (result.outputs as unknown as TOut)
            : undefined;
    const error = result.error;
    const usage: RunUsage = { ...ZERO_USAGE, durationMs };
    const handle: Run<TOut> = {
        runId: result.runId,
        surfaceRunId,
        status,
        output,
        error,
        usage,
        durationMs,
        events() {
            return eventsFactory(result.runId);
        },
        async waitForTerminal() {
            return handle;
        },
    };
    return handle;
}

function mapWalkStatus(s: WalkResult['status']): RunHandleStatus {
    switch (s) {
        case 'completed': return 'completed';
        case 'errored':   return 'errored';
        case 'canceled':  return 'canceled';
        case 'paused':    return 'awaiting_input';
        default: {
            const _exhaustive: never = s;
            void _exhaustive;
            return 'errored';
        }
    }
}
