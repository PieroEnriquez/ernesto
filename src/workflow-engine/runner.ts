/**
 * Top-level runner factory. Wires the bus + dispatcher + store + HITL
 * controller into a single `WorkflowRunner` instance the backend's
 * `wire-fragua.ts` consumes (under its `FraguaInstance` alias).
 */

import { randomUUID } from 'node:crypto';
import type { StepKind } from '../workflows/types';
import type { StepKindHandler, EngineLogger } from './types/handler';
import type { FactEvent } from './types/event';
import type {
    DispatchWorkflowInput,
    DispatchWorkflowResult,
    EventSubscription,
    ResumeRunInput,
    SubscribeEventsOpts,
    WorkflowRunner,
} from './types/runner';
import type { WorkflowReader } from './workflow-reader';
import type { StorePort } from './store/port';
import { EventBus } from './event-bus';
import { HandlerDispatcher } from './dispatch';
import { InMemoryStore } from './store/in-memory-store';
import { HitlController, type HitlPauseInput } from './hitl';
import { walk } from './engine/walker';

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

    async dispatchWorkflow(
        input: DispatchWorkflowInput,
    ): Promise<DispatchWorkflowResult> {
        if (!this.reader) {
            throw new Error('no workflow reader registered');
        }
        const detail = await this.reader.read(input.slug);
        if (!detail) {
            throw new Error(`workflow not found: ${input.slug}`);
        }
        const runId = input.preallocatedRunId ?? `run-${input.slug}-${randomUUID()}`;
        this.seqByRun.set(runId, 0);

        // Tie the run to an abort controller. If the caller passed
        // a signal, chain to it; otherwise we own a fresh one so
        // `abortRun` can land.
        const ac = new AbortController();
        if (input.signal) {
            if (input.signal.aborted) ac.abort();
            else input.signal.addEventListener('abort', () => ac.abort());
        }
        this.inflightAborts.set(runId, ac);

        try {
            const merged: DispatchWorkflowInput = {
                ...input,
                signal: ac.signal,
            };
            return await walk(runId, detail.declaration, merged, {
                bus: this.bus,
                dispatcher: this.dispatcher,
                store: this.store,
                hitl: this.hitl,
                log: this.log,
                nextSeq: (id) => this.nextSeq(id),
            });
        } finally {
            this.inflightAborts.delete(runId);
        }
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
}

export function createRunner(opts: CreateRunnerOpts = {}): WorkflowRunner {
    return new Runner(opts);
}
