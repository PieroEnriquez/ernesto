/**
 * Step-graph walker. Promoted from the backend's
 * `real-fragua-instance.ts:dispatchWorkflow` body, with HITL pause
 * integration grafted on top.
 *
 * Walking strategy (Phase 0): declaration-order iteration. The
 * `edge-selection` module exists for the eventual graph-driven walk
 * but the current shape matches what the backend stub already does
 * — flat enumeration of `steps:` keys, halting on the first non-
 * `completed` result.
 *
 * The walker emits the canonical `fact.*` event taxonomy through the
 * event bus + the store; `wire-fragua.ts:translateFactEvent` converts
 * those to `ErnestoTierEvent` for per-tier subscribers.
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
} from '../types/handler';
import type {
    DispatchWorkflowInput,
    DispatchWorkflowResult,
} from '../types/runner';
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

export async function walk(
    runId: string,
    declaration: WorkflowDeclaration,
    input: DispatchWorkflowInput,
    deps: WalkerDeps,
): Promise<DispatchWorkflowResult> {
    const routing: Record<string, unknown> = {
        ...input.context,
        userId: input.principal.userId,
        scopes: [...input.principal.scopes],
    };
    const signal = input.signal ?? new AbortController().signal;

    // Persist run-state row + emit fact.run_started.
    const startedAt = Date.now();
    await deps.store.putRunState({
        runId,
        workflow: input.slug,
        status: 'running',
        inputs: input.inputs,
        routing,
        startedAt,
    });
    emit(deps, {
        runId,
        seq: deps.nextSeq(runId),
        type: 'fact.run_started',
        payload: { workflow: input.slug, inputs: input.inputs },
        ts: startedAt,
        routing,
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
                    routing,
                });
                await markEnded(deps.store, runId, 'aborted');
                return { runId, status: 'canceled', outputs };
            }

            const handler = deps.dispatcher.require(step.kind);
            const expandedStep = expandStepTemplates(step, input.inputs);
            const stepEmit: EmitFactEvent = (input: EmitFactEventInput) => {
                const ts = input.ts ?? Date.now();
                const { ts: _t, ...rest } = input;
                emit(deps, {
                    runId,
                    seq: deps.nextSeq(runId),
                    type: input.type,
                    payload: { stepId, ...rest } as Record<string, unknown>,
                    ts,
                    routing,
                });
            };
            const ctx: HandlerContext = {
                runId,
                stepId,
                routing,
                signal,
                log: deps.log,
                emit: stepEmit,
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
                    routing,
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
                    routing,
                });
                outputs[stepId] = resumed;
                emit(deps, {
                    runId,
                    seq: deps.nextSeq(runId),
                    type: 'fact.node_completed',
                    payload: { nodeId: stepId, output: resumed },
                    ts: Date.now(),
                    routing,
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
                routing,
            });
        }

        emit(deps, {
            runId,
            seq: deps.nextSeq(runId),
            type: 'fact.run_terminated',
            payload: { status: 'completed' },
            ts: Date.now(),
            routing,
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
            routing,
        });
        await markEnded(deps.store, runId, 'errored', { message });
        return { runId, status: 'errored', outputs, error: { message } };
    }
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


const INPUTS_REF_RE = /\{\{\s*inputs\.([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

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
