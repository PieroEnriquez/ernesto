/**
 * Step-graph walker — the inner loop of every `dispatch(...)`.
 *
 * Takes a resolved `WorkflowDeclaration` + the dispatch input (kind,
 * inputs, principal, opts), iterates the steps in declaration order,
 * calls the registered step-kind handler for each, threads outputs
 * forward, blocks on HITL pauses, halts on errors, and emits the
 * canonical `fact.*` event taxonomy through the bus + store.
 *
 * Walking strategy (Phase 0): declaration-order iteration. The
 * `edge-selection` module exists for the eventual graph-driven walk
 * but the current shape matches what the prior stub did — flat
 * enumeration of `steps:` keys, halting on the first non-`completed`
 * result.
 */

import type { WorkflowDeclaration } from '../../workflows/types';
import type { EventBus } from '../event-bus';
import type { HandlerDispatcher } from '../dispatch';
import type { StorePort } from '../store/port';
import type { HitlController } from '../hitl';
import type {
    EngineLogger,
    EmitFactEvent,
    EmitFactEventInput,
    HandlerContext,
    HandlerRouting,
} from '../types/handler';
import type { DispatchOpts, KindRef } from '../types/runner';
import type { Principal } from '../principal';
import type { FactEvent } from '../types/event';
import { compileSteps } from '../types/graph';
import { projectStepOutput } from './render-projection';

export interface WalkerDeps {
    bus: EventBus;
    dispatcher: HandlerDispatcher;
    store: StorePort;
    hitl: HitlController;
    log: EngineLogger;
    /** Hands out the next event seq for a given run. */
    nextSeq(runId: string): number;
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
    /** Workdir root set by middleware (workspace-allocator). Threaded
     *  into every step's HandlerContext.workdirRoot so step handlers
     *  can pin route/agent dispatches to the allocated workdir. */
    workdirRoot?: string;
    /** Middleware-written per-dispatch annotations. Plumbed into every
     *  step's HandlerContext.annotations so handlers can read
     *  middleware-provided MCP server maps, sandbox hooks, provider
     *  env vars, etc. */
    annotations?: Readonly<Record<string, unknown>>;
}

export async function walk(
    runId: string,
    declaration: WorkflowDeclaration,
    input: WalkInput,
    deps: WalkerDeps,
): Promise<WalkResult> {
    const routing: HandlerRouting = buildRouting(input);
    const signal = input.opts.abortSignal ?? new AbortController().signal;

    // Persist run-state row + emit fact.run_started. The store-row
    // routing carries the typed shape so projection reducers don't
    // need to fish keys out of an untyped record.
    const startedAt = Date.now();
    await deps.store.putRunState({
        runId,
        workflow: input.kind,
        status: 'running',
        inputs: input.inputs,
        routing: routingForStore(routing, input.principal),
        startedAt,
    });
    emit(deps, {
        runId,
        seq: deps.nextSeq(runId),
        type: 'fact.run_started',
        payload: { workflow: input.kind, inputs: input.inputs },
        ts: startedAt,
        routing: routingForStore(routing, input.principal),
    });

    const outputs: Record<string, unknown> = {};
    const steps = compileSteps(declaration);

    try {
        for (const { id: stepId, step } of steps) {
            if (signal.aborted) {
                emit(deps, {
                    runId,
                    seq: deps.nextSeq(runId),
                    type: 'fact.run_terminated',
                    payload: { status: 'aborted' },
                    ts: Date.now(),
                    routing: routingForStore(routing, input.principal),
                });
                await markEnded(deps.store, runId, 'aborted');
                return { runId, status: 'canceled', outputs };
            }

            const handler = deps.dispatcher.require(step.kind);
            const expandedStep = expandStepTemplates(step, input.inputs);
            const stepEmit: EmitFactEvent = (raw: EmitFactEventInput) => {
                const ts = raw.ts ?? Date.now();
                const { ts: _t, ...rest } = raw;
                emit(deps, {
                    runId,
                    seq: deps.nextSeq(runId),
                    type: raw.type,
                    payload: { stepId, ...rest } as Record<string, unknown>,
                    ts,
                    routing: routingForStore(routing, input.principal),
                });
            };
            const ctx: HandlerContext = {
                runId,
                stepId,
                principal: input.principal,
                routing,
                runInputs: input.inputs,
                annotations: input.annotations ?? {},
                signal,
                log: deps.log,
                emit: stepEmit,
                ...(input.workdirRoot !== undefined
                    ? { workdirRoot: input.workdirRoot }
                    : {}),
            };
            const result = await handler(expandedStep, ctx);

            if (result.kind === 'error') {
                emit(deps, {
                    runId,
                    seq: deps.nextSeq(runId),
                    type: 'fact.run_terminated',
                    payload: {
                        status: 'errored',
                        code: result.code,
                        message: result.message,
                        stepId,
                    },
                    ts: Date.now(),
                    routing: routingForStore(routing, input.principal),
                });
                await markEnded(deps.store, runId, 'errored', {
                    message: result.message,
                });
                return {
                    runId,
                    status: 'errored',
                    outputs,
                    error: {
                        code: result.code,
                        message: result.message,
                        stepId,
                    },
                };
            }

            if (result.kind === 'paused_human') {
                // Block on the HITL controller until an external
                // `resumeRun` lands. The pause-promise resolves with
                // the value the submitter provided; we stash it as
                // the step's output and continue.
                const resumed = await deps.hitl.pauseForHuman({
                    runId,
                    stepId,
                    schema:
                        (result.schema as Record<string, unknown>) ?? {},
                    prompt: result.prompt,
                    routes: result.routes,
                    routing: routingForStore(routing, input.principal),
                });
                outputs[stepId] = resumed;
                emit(deps, {
                    runId,
                    seq: deps.nextSeq(runId),
                    type: 'fact.node_completed',
                    payload: { nodeId: stepId, output: resumed },
                    ts: Date.now(),
                    routing: routingForStore(routing, input.principal),
                });
                continue;
            }

            const projected = projectStepOutput(
                result.output,
                stepEmit,
                deps.log,
                stepId,
            );
            outputs[stepId] = projected;
            emit(deps, {
                runId,
                seq: deps.nextSeq(runId),
                type: 'fact.node_completed',
                payload: { nodeId: stepId, output: projected },
                ts: Date.now(),
                routing: routingForStore(routing, input.principal),
            });
        }

        emit(deps, {
            runId,
            seq: deps.nextSeq(runId),
            type: 'fact.run_terminated',
            payload: { status: 'completed' },
            ts: Date.now(),
            routing: routingForStore(routing, input.principal),
        });
        await markEnded(deps.store, runId, 'completed');
        return { runId, status: 'completed', outputs };
    } catch (err) {
        const message = (err as Error).message;
        emit(deps, {
            runId,
            seq: deps.nextSeq(runId),
            type: 'fact.run_terminated',
            payload: { status: 'errored', message },
            ts: Date.now(),
            routing: routingForStore(routing, input.principal),
        });
        await markEnded(deps.store, runId, 'errored', { message });
        return { runId, status: 'errored', outputs, error: { message } };
    }
}

/** Build the typed `HandlerRouting` from the dispatch input. */
function buildRouting(input: WalkInput): HandlerRouting {
    const r: HandlerRouting = {
        context: input.opts.context ?? {},
    };
    if (input.opts.tier !== undefined) r.tier = input.opts.tier;
    if (input.opts.surfaceRunId !== undefined) r.surfaceRunId = input.opts.surfaceRunId;
    if (input.opts.parentRunId !== undefined) r.parentRunId = input.opts.parentRunId;
    if (input.opts.conversationKey !== undefined) r.conversationKey = input.opts.conversationKey;
    return r;
}

/** Project the typed routing into the store/event-row payload shape.
 *  Includes the principal identity for audit + reducer convenience.
 *  The store's `routing` field stays an untyped record because
 *  downstream projection workers may add their own keys without
 *  changing this schema. */
function routingForStore(
    r: HandlerRouting,
    p: Principal,
): Record<string, unknown> {
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

/**
 * Walk every string in a step and replace `{{ inputs.<name> }}`
 * references with the run's input values. Mirrors the lightweight
 * substitution master applied at the SDK-options compile point —
 * step handlers see fully-resolved fields and never need to know
 * about the template syntax.
 */
function expandStepTemplates<T>(step: T, inputs: Record<string, unknown>): T {
    return walkValue(step, inputs) as T;
}


// Match `{{ inputs.X }}` but NOT `${{ inputs.X }}` — the `${{ }}` form
// is the new orchestration interpolation grammar (handled by the
// orchestration-handler, not the walker). Negative lookbehind on `$`
// keeps the two grammars from colliding when nested.
const INPUTS_REF_RE = /(?<!\$)\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function walkValue(value: unknown, inputs: Record<string, unknown>): unknown {
    if (typeof value === 'string') return substituteString(value, inputs);
    if (Array.isArray(value)) return value.map((v) => walkValue(v, inputs));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = walkValue(v, inputs);
        }
        return out;
    }
    return value;
}

function substituteString(s: string, inputs: Record<string, unknown>): string {
    return s.replace(INPUTS_REF_RE, (_m, key) => {
        const v = inputs[key];
        if (v === undefined || v === null) return '';
        return typeof v === 'string' ? v : JSON.stringify(v);
    });
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
    const endedAt = Date.now();
    await store.putRunState({
        ...state,
        status,
        endedAt,
        ...(error ? { error } : {}),
    });
}
