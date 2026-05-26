/**
 * walk — the run-lifecycle wrapper around the DAG engine.
 *
 * Every `dispatch(...)` runs its workflow through here. `walk` owns
 * the run-level concerns — persist run state, emit `fact.run_started`
 * / `fact.run_terminated`, map the graph result to a terminal — and
 * delegates the actual step scheduling to `runGraph` (the one
 * recursive DAG engine). A workflow IS a DAG; a route is a trivial
 * one-node DAG; a `group` step is a nested DAG run by the same engine.
 */

import type { WorkflowDeclaration } from '../../workflows/types';
import type { EventBus } from '../event-bus';
import type { HandlerDispatcher } from '../dispatch';
import type { StorePort } from '../store/port';
import type { HitlController } from '../hitl';
import type { EngineLogger, HandlerRouting } from '../types/handler';
import type { DispatchOpts, KindRef } from '../types/runner';
import type { Principal } from '../principal';
import type { FactEvent } from '../types/event';
import { runGraph, type RunGraphDeps } from './run-graph';

export interface WalkerDeps {
    bus: EventBus;
    dispatcher: HandlerDispatcher;
    store: StorePort;
    hitl: HitlController;
    log: EngineLogger;
    /** Hands out the next event seq for a given run. */
    nextSeq(runId: string): number;
    /** Recursive dispatch closure built by the runner. Pre-binds the
     *  parent run's principal + routing (tier, parentRunId =
     *  ctx.runId, surfaceRunId, conversationKey) so step handlers can
     *  call `ctx.dispatch(uri, inputs)` without re-supplying them.
     *  Optional for unit-test setups that don't recurse. */
    dispatch?: (
        uri: string,
        inputs: Record<string, unknown>,
        parent: { runId: string; principal: Principal; routing: HandlerRouting },
    ) => Promise<{
        runId: string;
        status: 'completed' | 'errored' | 'canceled' | 'running' | 'awaiting_input';
        output?: Record<string, unknown>;
        error?: { code?: string; message?: string; stepId?: string };
    }>;
}

/** Internal terminal shape returned by `walk`. The runner wraps this
 *  into a `Run<TOut>` handle for the caller. */
export interface WalkResult {
    runId: string;
    status: 'completed' | 'errored' | 'canceled' | 'paused';
    outputs: Record<string, unknown>;
    error?: {
        code?: string;
        message?: string;
        stepId?: string;
    };
}

export interface WalkInput {
    kind: KindRef;
    inputs: Record<string, unknown>;
    principal: Principal;
    opts: DispatchOpts;
    /** Workdir root set by the workspace-allocator middleware. */
    workdirRoot?: string;
    /** Middleware-written per-dispatch annotations. */
    annotations?: Readonly<Record<string, unknown>>;
}

export async function walk(
    runId: string,
    declaration: WorkflowDeclaration,
    input: WalkInput,
    deps: WalkerDeps,
): Promise<WalkResult> {
    const routing = buildRouting(input);
    const storeRouting = routingForStore(routing, input.principal);
    const signal = input.opts.abortSignal ?? new AbortController().signal;
    const startedAt = Date.now();

    await deps.store.putRunState({
        runId,
        workflow: input.kind,
        status: 'running',
        inputs: input.inputs,
        routing: storeRouting,
        startedAt,
    });
    emit(deps, {
        runId,
        seq: deps.nextSeq(runId),
        type: 'fact.run_started',
        payload: { workflow: input.kind, inputs: input.inputs },
        ts: startedAt,
        routing: storeRouting,
    });

    const graphDeps: RunGraphDeps = {
        dispatcher: deps.dispatcher,
        hitl: deps.hitl,
        log: deps.log,
        signal,
        runId,
        principal: input.principal,
        routing,
        runInputs: input.inputs,
        annotations: input.annotations ?? {},
        emitFact: (event) => emit(deps, event),
        nextSeq: (id) => deps.nextSeq(id),
        storeRouting,
        ...(input.workdirRoot !== undefined ? { workdirRoot: input.workdirRoot } : {}),
        // Pre-bind the recursive-dispatch closure for step handlers
        // (`ctx.dispatch(uri, inputs)`). Parent identity (runId,
        // principal, routing) is captured here so handlers don't
        // re-supply it; the runner-side closure threads it into
        // `dispatchOpts` as `parentRunId` + routing inheritance.
        ...(deps.dispatch !== undefined
            ? {
                  dispatch: (uri: string, inputs: Record<string, unknown>) =>
                      deps.dispatch!(uri, inputs, {
                          runId,
                          principal: input.principal,
                          routing,
                      }),
              }
            : {}),
    };

    const result = await runGraph(
        {
            steps: declaration.steps,
            ...(declaration.concurrency !== undefined
                ? { concurrency: declaration.concurrency }
                : {}),
            ...(declaration.outputs !== undefined
                ? { outputs: declaration.outputs }
                : {}),
        },
        graphDeps,
    );

    if (result.status === 'canceled') {
        emit(deps, {
            runId,
            seq: deps.nextSeq(runId),
            type: 'fact.run_terminated',
            payload: { status: 'aborted' },
            ts: Date.now(),
            routing: storeRouting,
        });
        await markEnded(deps.store, runId, 'aborted');
        return { runId, status: 'canceled', outputs: result.outputs };
    }

    if (result.status === 'errored') {
        emit(deps, {
            runId,
            seq: deps.nextSeq(runId),
            type: 'fact.run_terminated',
            payload: { status: 'errored', ...result.error },
            ts: Date.now(),
            routing: storeRouting,
        });
        await markEnded(deps.store, runId, 'errored', {
            message: result.error.message ?? 'workflow errored',
        });
        return { runId, status: 'errored', outputs: result.outputs, error: result.error };
    }

    emit(deps, {
        runId,
        seq: deps.nextSeq(runId),
        type: 'fact.run_terminated',
        payload: { status: 'completed' },
        ts: Date.now(),
        routing: storeRouting,
    });
    await markEnded(deps.store, runId, 'completed');
    return { runId, status: 'completed', outputs: result.outputs };
}

/** Build the typed `HandlerRouting` from the dispatch input. */
function buildRouting(input: WalkInput): HandlerRouting {
    const r: HandlerRouting = { context: input.opts.context ?? {} };
    if (input.opts.tier !== undefined) r.tier = input.opts.tier;
    if (input.opts.surfaceRunId !== undefined) r.surfaceRunId = input.opts.surfaceRunId;
    if (input.opts.parentRunId !== undefined) r.parentRunId = input.opts.parentRunId;
    if (input.opts.conversationKey !== undefined) r.conversationKey = input.opts.conversationKey;
    return r;
}

/** Project typed routing into the store/event-row payload shape. */
function routingForStore(r: HandlerRouting, p: Principal): Record<string, unknown> {
    return {
        ...r.context,
        ...(r.tier !== undefined ? { tier: r.tier } : {}),
        ...(r.surfaceRunId !== undefined ? { surfaceRunId: r.surfaceRunId } : {}),
        ...(r.parentRunId !== undefined ? { parentRunId: r.parentRunId } : {}),
        ...(r.conversationKey !== undefined ? { conversationKey: r.conversationKey } : {}),
        principalKind: p.kind,
        ...(p.kind === 'user'
            ? { userId: p.userId, scopes: [...p.scopes] }
            : { workerId: p.workerId, requestId: p.requestId }),
    };
}

function emit(deps: WalkerDeps, event: FactEvent): void {
    deps.bus.emit(event);
    deps.store.appendEvent({
        runId: event.runId,
        type: event.type,
        writer: 'engine',
        payload: event.payload,
        ts: event.ts,
        ...(event.routing ? { routing: event.routing } : {}),
    });
}

async function markEnded(
    store: StorePort,
    runId: string,
    status: 'completed' | 'errored' | 'aborted',
    error?: { message: string; stack?: string },
): Promise<void> {
    const state = await store.getRunState(runId);
    if (!state) return;
    await store.putRunState({
        ...state,
        status,
        endedAt: Date.now(),
        ...(error ? { error } : {}),
    });
}
