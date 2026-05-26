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
import type { WorkflowReader, WorkflowDetail } from './workflow-reader';
import type { StorePort } from './store/port';
import type { Principal } from './principal';
import { EventBus } from './event-bus';
import { HandlerDispatcher } from './dispatch';
import { InMemoryStore } from './store/in-memory-store';
import { HitlController, type HitlPauseInput } from './hitl';
import { walk, type WalkResult } from './engine/walker';
import { KindRegistry } from './kind-registry';
import {
    type DispatchMiddleware,
    type DispatchPreContext,
    buildPreContext,
    runBefore,
    runAfter,
} from './middleware';

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

    // M5: unified kind registry. The reader continues to load
    // workflows lazily from disk; programmatic kinds (routes,
    // backend-registered workflows) live here.
    readonly kindRegistry = new KindRegistry();

    // M6: ordered middleware chain. Runs around every dispatch via
    // `runBefore` + `runAfter`. Registered via `runner.use(mw)`.
    private readonly middlewares: DispatchMiddleware[] = [];

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
        // No `parallel`/`orchestration` handlers to register — the DAG
        // engine (`runGraph`) IS the composition primitive now. The
        // workflow's step map is a DAG; a `group` step is a nested DAG
        // handled inline by the engine (not a dispatcher kind). The
        // dispatcher carries only leaf handlers (route/input/agent/
        // subworkflow), supplied by the caller.
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

    /** M6: register a middleware in the dispatch chain. Order matters:
     *  `before` hooks run in registration order; `after` hooks run in
     *  reverse (LIFO). No de-registration — boot wires the chain
     *  once. */
    use(mw: DispatchMiddleware): void {
        this.middlewares.push(mw);
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
        // M5: resolve via the kind registry first. Falls back to the
        // workflow reader for workspace-loaded workflows that haven't
        // been registered programmatically.
        const declFromRegistry = this.kindRegistry.resolve(kind);
        let workflowDecl: WorkflowDetail;
        if (declFromRegistry && declFromRegistry.kind === 'workflow') {
            workflowDecl = {
                name: declFromRegistry.declaration.name,
                path: `kind-registry://${declFromRegistry.uri}`,
                sha: '',
                source: 'kind-registry',
                declaration: declFromRegistry.declaration,
            };
        } else if (declFromRegistry && declFromRegistry.kind === 'route') {
            // Route kinds dispatch as a single-step workflow with one
            // route step. The substrate's promise: dispatch is uniform
            // across routes and workflows.
            workflowDecl = {
                name: declFromRegistry.uri,
                path: `kind-registry://${declFromRegistry.uri}`,
                sha: '',
                source: 'kind-registry',
                declaration: {
                    name: declFromRegistry.uri,
                    description: declFromRegistry.route.description,
                    version: 1 as const,
                    ...(declFromRegistry.route.scope &&
                    Array.isArray(declFromRegistry.route.scope)
                        ? { scope: [...declFromRegistry.route.scope] }
                        : {}),
                    steps: {
                        main: {
                            kind: 'route' as const,
                            uri: declFromRegistry.uri,
                            params: inputs,
                        },
                    },
                },
            };
        } else {
            if (!this.reader) {
                throw new Error('no workflow reader registered');
            }
            const detail = await this.reader.read(kind);
            if (!detail) {
                throw new Error(`workflow not found: ${kind}`);
            }
            workflowDecl = detail;
        }

        const runId =
            opts.preallocatedRunId ?? `run-${kind}-${randomUUID()}`;
        this.seqByRun.set(runId, 0);

        const startedAt = Date.now();
        const surfaceRunId = opts.surfaceRunId ?? runId;

        // M6: run pre-dispatch middleware chain BEFORE setting up the
        // abort controller. Middleware (notably `timeoutMiddleware`)
        // may replace `opts.abortSignal` with a composed signal; the
        // runner reads the post-middleware value when building its
        // own AbortController. Errors from `before` hooks (e.g.
        // scope-check throws ScopeEscalationError) abort the dispatch
        // — the caller sees the rejection directly.
        const preCtx: DispatchPreContext = buildPreContext(kind, inputs, principal, opts, runId);
        if (declFromRegistry) preCtx.decl = declFromRegistry;
        const postPreCtx = await runBefore(this.middlewares, preCtx);

        // Cache short-circuit: `resultCacheMiddleware` (or any
        // middleware following the same protocol) writes
        // `__cacheHit` onto annotations when a fresh cached output
        // exists. Skip the walk entirely; synthesize a completed
        // WalkResult so after-hooks observe the cache hit alongside
        // a normal terminal. The synthetic walk emits no fact events
        // (no store rows, no bus traffic) — the caller's Run handle
        // reports status='completed' with the cached output and
        // zero usage / zero duration credit for this dispatch.
        const cacheHit = postPreCtx.annotations.__cacheHit;
        if (cacheHit !== undefined) {
            const cachedWalkResult: WalkResult = {
                runId,
                status: 'completed',
                outputs: (cacheHit && typeof cacheHit === 'object'
                    ? (cacheHit as Record<string, unknown>)
                    : { value: cacheHit }) as Record<string, unknown>,
            };
            const cachedRun = projectRunHandle<TOut>(
                cachedWalkResult,
                surfaceRunId,
                startedAt,
                (filterRunId) => this.subscribeRunEvents(filterRunId),
            );
            await runAfter(this.middlewares, postPreCtx, cachedRun, (mw, err) => {
                this.log.warn('middleware after-hook failed (cache hit)', {
                    name: mw.name,
                    runId: cachedRun.runId,
                    errorMessage: (err as Error).message,
                });
            });
            return cachedRun;
        }

        // Tie the run to an abort controller chained to whatever
        // signal middleware left on opts.abortSignal (could be the
        // caller's original, a composed timeout signal, or both).
        const ac = new AbortController();
        const upstreamSignal = postPreCtx.opts.abortSignal;
        if (upstreamSignal) {
            if (upstreamSignal.aborted) ac.abort();
            else upstreamSignal.addEventListener('abort', () => ac.abort());
        }
        this.inflightAborts.set(runId, ac);

        // M6 retry: read kind.policy.retry; wrap walk() in a retry
        // loop. Each attempt walks fresh with the same runId so
        // consumers see one run; the bus subscriber sees N attempts
        // as N fact.run_started / fact.run_terminated cycles. The
        // last attempt's result is returned to the caller.
        const retry = postPreCtx.decl?.policy?.retry;
        const maxAttempts = Math.max(1, retry?.max ?? 1);
        const backoffMs = Math.max(0, retry?.backoffMs ?? 0);

        let walkResult: WalkResult;
        let attempt = 0;
        try {
            while (true) {
                attempt++;
                walkResult = await walk(
                    runId,
                    workflowDecl.declaration,
                    {
                        kind,
                        inputs: postPreCtx.inputs,
                        principal: postPreCtx.principal,
                        opts: { ...postPreCtx.opts, abortSignal: ac.signal },
                        ...(postPreCtx.workdirRoot !== undefined
                            ? { workdirRoot: postPreCtx.workdirRoot }
                            : {}),
                        ...(Object.keys(postPreCtx.annotations).length > 0
                            ? { annotations: postPreCtx.annotations }
                            : {}),
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
                // Only retry on `errored` — completed, paused, canceled
                // are terminal-as-is. The on:'transient' filter is a
                // future refinement; today every error is retryable
                // up to max.
                if (walkResult.status !== 'errored') break;
                if (attempt >= maxAttempts) break;
                if (ac.signal.aborted) break;
                if (backoffMs > 0) {
                    await sleepWithSignal(backoffMs, ac.signal);
                    if (ac.signal.aborted) break;
                }
                // Reset seq counter for the next attempt — each attempt
                // starts fresh from seq 0.
                this.seqByRun.set(runId, 0);
                this.log.info('retrying dispatch', {
                    kind,
                    runId,
                    attempt: attempt + 1,
                    maxAttempts,
                });
            }
        } finally {
            this.inflightAborts.delete(runId);
        }

        const run = projectRunHandle<TOut>(
            walkResult,
            surfaceRunId,
            startedAt,
            (filterRunId) => this.subscribeRunEvents(filterRunId),
        );

        // M6: post-dispatch middleware chain (reverse order). Errors
        // here don't override the run's terminal status — they're
        // logged + dropped so resource cleanup always completes.
        await runAfter(this.middlewares, postPreCtx, run, (mw, err) => {
            this.log.warn('middleware after-hook failed', {
                name: mw.name,
                runId: run.runId,
                errorMessage: (err as Error).message,
            });
        });

        return run;
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

/** Sleep with abort cooperation — resolves on either timer firing
 *  or the signal aborting. Used by retry between attempts. */
function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
        if (signal.aborted) return resolve();
        const t = setTimeout(resolve, ms);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(t);
                resolve();
            },
            { once: true },
        );
    });
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
