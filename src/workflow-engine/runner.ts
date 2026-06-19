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
import { HitlController, validateAgainstSchema, type HitlPauseInput } from './hitl';
import { walk, type WalkResult, type WalkerDeps } from './engine/walker';
import type { GraphSeed } from './engine/run-graph';
import { KindRegistry, mergeWorkflowPolicyDefaults } from './kind-registry';
import { type DispatchMiddleware, type DispatchPreContext, buildPreContext, runBefore, runAfter } from './middleware';

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
        this.hitl = new HitlController(this.bus, this.store, (runId) => this.nextSeq(runId));
    }

    registerStepKind(kind: StepKind, handler: StepKindHandler<any>): void {
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

    async subscribeEvents(opts: SubscribeEventsOpts): Promise<EventSubscription> {
        return this.bus.subscribe(opts);
    }

    emitFactEvent(raw: FactEvent): void {
        this.bus.emit(raw);
    }

    async dispatch<TOut extends Record<string, unknown> = Record<string, unknown>>(
        kind: KindRef,
        inputs: Record<string, unknown>,
        principal: Principal,
        opts: DispatchOpts = {},
    ): Promise<Run<TOut>> {
        // M5: resolve via the kind registry first, falling back to the
        // workflow reader. Shared with the resume path (`resumeDurable`).
        const { workflowDecl, declFromRegistry } = await this.resolveKind(kind, inputs);

        // The runId is embedded verbatim into downstream identifiers that
        // require a `[A-Za-z0-9_-]` charset — notably the Slack HITL button's
        // `action_id` (`ui_input_<runId>__…`). A `kind` that is a route URI
        // (`<ws>://<name>`) would otherwise inject `:` and `/` into the runId
        // and break the button → resume round-trip. Sanitize the kind to that
        // charset here; the `randomUUID()` suffix keeps it unique regardless.
        const runId = opts.preallocatedRunId ?? `run-${kind.replace(/[^A-Za-z0-9_-]/g, '_')}-${randomUUID()}`;
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
        if (declFromRegistry) {
            preCtx.decl = declFromRegistry;
        } else if (workflowDecl.declaration) {
            // Reader-loaded workflow: synthesize a KindDecl with the same
            // safety defaults `registerWorkflow` applies, so workspace-bound
            // middleware (notably `workspaceAllocatorMiddleware`) sees the
            // `physicalTree: 'eager'` invariant for agent-main workflows
            // that arrive via the reader without going through the registry.
            const synthesizedPolicy = mergeWorkflowPolicyDefaults(workflowDecl.declaration, undefined);
            preCtx.decl = {
                kind: 'workflow',
                uri: workflowDecl.name,
                declaration: workflowDecl.declaration,
                ...(synthesizedPolicy !== undefined ? { policy: synthesizedPolicy } : {}),
            };
        }
        const postPreCtx = await runBefore(this.middlewares, preCtx);

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
                        ...(postPreCtx.workdirRoot !== undefined ? { workdirRoot: postPreCtx.workdirRoot } : {}),
                        ...(postPreCtx.workspaceView !== undefined ? { workspaceView: postPreCtx.workspaceView } : {}),
                        ...(Object.keys(postPreCtx.annotations).length > 0 ? { annotations: postPreCtx.annotations } : {}),
                    },
                    this.walkerDeps(),
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

        const run = projectRunHandle<TOut>(walkResult, surfaceRunId, startedAt, (filterRunId) => this.subscribeRunEvents(filterRunId));

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
        // Two pause mechanisms share this entry point:
        //
        //  1. In-heap agent pause — `ui.input` called `pauseForHuman`
        //     mid-agent-turn; the SDK turn is suspended waiting for the
        //     tool result. Resolve the in-heap promise so the turn
        //     continues. Restart-fragile by nature (harness path).
        //  2. Durable step-level pause — a step returned `paused_human`
        //     or `paused_signal`; the run parked with no in-heap promise.
        //     Re-enter the walk from the persisted resume state.
        if (this.hitl.hasPending(input.runId, input.promptId)) {
            await this.hitl.resume(input.runId, {
                promptId: input.promptId,
                value: input.value,
            });
            return;
        }
        await this.resumeDurable(input);
    }

    /** Re-enter a paused run from durable state. Validates the resume
     *  value against the parked step's schema, then re-walks: the seed
     *  pre-satisfies completed/skipped steps and resolves the parked
     *  step, so handlers don't re-run. Survives a pod restart — the
     *  only state read is the durable run row. */
    private async resumeDurable(input: ResumeRunInput): Promise<void> {
        const state = await this.store.getRunState(input.runId);
        const notPending = `no pending HITL for run ${input.runId} prompt ${input.promptId}`;
        if (!state || state.status !== 'paused' || !state.resume) {
            throw new Error(notPending);
        }
        const parked = state.resume.paused.find((p) => p.promptId === input.promptId);
        if (!parked) throw new Error(notPending);

        const validationError = validateAgainstSchema(input.value, parked.schema ?? {});
        if (validationError) {
            throw new Error(`HITL value invalid: ${validationError}`);
        }

        const { workflowDecl } = await this.resolveKind(state.workflow, state.inputs);

        const seed: GraphSeed = {
            outputs: state.resume.outputs,
            skipped: state.resume.skipped,
            resolved: { [parked.stepId]: input.value },
            // Any other still-parked pauses stay parked (re-held without
            // re-running their handler) — multi-pause runs converge over
            // successive resumes.
            parked: state.resume.paused.filter((p) => p.promptId !== input.promptId),
        };

        const ac = new AbortController();
        this.inflightAborts.set(input.runId, ac);
        if (!this.seqByRun.has(input.runId)) this.seqByRun.set(input.runId, 0);
        try {
            await walk(
                input.runId,
                workflowDecl.declaration,
                {
                    kind: state.workflow,
                    inputs: state.inputs,
                    principal: principalFromRouting(state.routing),
                    opts: { ...optsFromRouting(state.routing), abortSignal: ac.signal },
                    resume: { seed, promptId: input.promptId },
                },
                this.walkerDeps(),
            );
        } finally {
            this.inflightAborts.delete(input.runId);
        }
    }

    /** Resolve a kind to its frozen declaration via the registry first,
     *  then the workflow reader. Shared by `dispatch` + `resumeDurable`.
     *  Route kinds become a single-step `route` workflow so dispatch is
     *  uniform across routes and workflows. */
    private async resolveKind(
        kind: KindRef,
        inputs: Record<string, unknown>,
    ): Promise<{
        workflowDecl: WorkflowDetail;
        declFromRegistry: ReturnType<KindRegistry['resolve']>;
    }> {
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
            workflowDecl = {
                name: declFromRegistry.uri,
                path: `kind-registry://${declFromRegistry.uri}`,
                sha: '',
                source: 'kind-registry',
                declaration: {
                    name: declFromRegistry.uri,
                    description: declFromRegistry.route.description ?? declFromRegistry.uri,
                    version: 1 as const,
                    ...(declFromRegistry.route.scope && Array.isArray(declFromRegistry.route.scope)
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
        return { workflowDecl, declFromRegistry };
    }

    /** Build the per-walk `WalkerDeps`. Shared by `dispatch` and the
     *  resume re-walk so both use the same recursive-dispatch closure
     *  (step handlers get a pre-bound `ctx.dispatch(uri, inputs)` that
     *  threads the parent run's identity + routing into the child). */
    private walkerDeps(): WalkerDeps {
        return {
            bus: this.bus,
            dispatcher: this.dispatcher,
            store: this.store,
            log: this.log,
            nextSeq: (id) => this.nextSeq(id),
            dispatch: async (uri, inputs, parent) => {
                const childOpts: DispatchOpts = {
                    ...parent.routing.context,
                    parentRunId: parent.runId,
                    ...(parent.routing.transport !== undefined ? { transport: parent.routing.transport } : {}),
                    ...(parent.routing.surfaceRunId !== undefined ? { surfaceRunId: parent.routing.surfaceRunId } : {}),
                    ...(parent.routing.conversationKey !== undefined ? { conversationKey: parent.routing.conversationKey } : {}),
                    context: parent.routing.context,
                };
                const child = await this.dispatch(uri, inputs, parent.principal, childOpts);
                return {
                    runId: child.runId,
                    status: child.status,
                    ...(child.output !== undefined ? { output: child.output } : {}),
                    ...(child.error !== undefined ? { error: child.error } : {}),
                };
            },
        };
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
        const next = this.seqByRun.get(runId) ?? 0;
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
                        await new Promise<void>((resolve) => wakers.push(resolve));
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
    const output = result.status === 'completed' ? (result.outputs as unknown as TOut) : undefined;
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

/** Reconstruct the dispatch `Principal` from the persisted routing
 *  snapshot (`walker.ts:routingForStore` is the inverse). Used by the
 *  resume re-walk, which has only the durable run row to work from. */
function principalFromRouting(routing: Record<string, unknown>): Principal {
    if (routing.principalKind === 'service') {
        return {
            kind: 'service',
            workerId: typeof routing.workerId === 'string' ? routing.workerId : 'worker',
            requestId: typeof routing.requestId === 'string' ? routing.requestId : '',
        };
    }
    return {
        kind: 'user',
        userId: typeof routing.userId === 'string' ? routing.userId : 'unknown',
        scopes: new Set(Array.isArray(routing.scopes) ? (routing.scopes as string[]) : []),
    };
}

/** Reconstruct `DispatchOpts` from the persisted routing snapshot so the
 *  resume re-walk re-derives the same `HandlerRouting`. Substrate fields
 *  map to typed opts; everything else is replayed as `context`. */
function optsFromRouting(routing: Record<string, unknown>): DispatchOpts {
    const opts: DispatchOpts = {};
    if (routing.transport === 'in-process' || routing.transport === 'mcp' || routing.transport === 'laptop' || routing.transport === 'vm') {
        opts.transport = routing.transport;
    }
    if (typeof routing.surfaceRunId === 'string') opts.surfaceRunId = routing.surfaceRunId;
    if (typeof routing.parentRunId === 'string') opts.parentRunId = routing.parentRunId;
    if (typeof routing.conversationKey === 'string') {
        opts.conversationKey = routing.conversationKey;
    }
    const RESERVED = new Set([
        'transport',
        'surfaceRunId',
        'parentRunId',
        'conversationKey',
        'principalKind',
        'userId',
        'scopes',
        'workerId',
        'requestId',
    ]);
    const context: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(routing)) {
        if (!RESERVED.has(k)) context[k] = v;
    }
    opts.context = context;
    return opts;
}

function mapWalkStatus(s: WalkResult['status']): RunHandleStatus {
    switch (s) {
        case 'completed':
            return 'completed';
        case 'errored':
            return 'errored';
        case 'canceled':
            return 'canceled';
        case 'paused':
            return 'awaiting_input';
        default: {
            const _exhaustive: never = s;
            void _exhaustive;
            return 'errored';
        }
    }
}
