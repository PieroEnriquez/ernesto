/**
 * run-graph — the workflow engine's one and only step scheduler.
 *
 * A workflow IS a DAG. `runGraph` executes a step graph: topological
 * order from `depends:` (with `next:` as linear sugar), independent
 * steps in parallel up to `concurrency`, `${{ inputs.X }}` +
 * `${{ steps.X.outputs.Y }}` interpolation into each step, `skipIf:`
 * gating, `fallback:` on error, inline HITL pause/resume, and output
 * aggregation.
 *
 * There is no separate "orchestration" or "parallel" step kind — both
 * collapsed into this engine. The top-level workflow runs through
 * `runGraph`; a `group` step runs through the SAME `runGraph`
 * recursively with its own concurrency budget and a path-prefixed node
 * id. The walker (`walk`) is a thin lifecycle wrapper that calls this.
 */

import type {
    WorkflowStep,
    WorkflowOutput,
    GroupStep,
} from '../../workflows/types';
import type { HandlerDispatcher } from '../dispatch';
import type { HitlController } from '../hitl';
import type {
    EngineLogger,
    EmitFactEvent,
    HandlerContext,
    HandlerResult,
    HandlerRouting,
} from '../types/handler';
import type { FactEvent } from '../types/event';
import type { Principal } from '../principal';
import { projectStepOutput } from './render-projection';

/** Everything the scheduler needs that's constant across the run. */
export interface RunGraphDeps {
    dispatcher: HandlerDispatcher;
    /** Recursive dispatch handle threaded into every step's
     *  `HandlerContext.dispatch`. The walker pre-binds principal +
     *  routing inheritance; step handlers call it with just the URI
     *  + inputs. Optional — `walk()` sets it when called from the
     *  runner; unit-test setups that drive `runGraph` directly may
     *  omit it (step handlers receiving an undefined `dispatch` is a
     *  contract failure only for handlers that NEED recursion — the
     *  route step handler's "dispatch any kind" path is the canonical
     *  consumer; others continue to no-op). */
    dispatch?: (
        uri: string,
        inputs: Record<string, unknown>,
    ) => Promise<{
        runId: string;
        status: 'completed' | 'errored' | 'canceled' | 'running' | 'awaiting_input';
        output?: Record<string, unknown>;
        error?: { code?: string; message?: string; stepId?: string };
    }>;
    hitl: HitlController;
    log: EngineLogger;
    signal: AbortSignal;
    runId: string;
    principal: Principal;
    routing: HandlerRouting;
    runInputs: Record<string, unknown>;
    annotations: Readonly<Record<string, unknown>>;
    workdirRoot?: string;
    /** Low-level fact emit (bus + store append). The scheduler wraps
     *  it per-node to inject the path-qualified stepId. */
    emitFact: (event: FactEvent) => void;
    nextSeq: (runId: string) => number;
    /** Routing projected into the store/event-row shape. */
    storeRouting: Record<string, unknown>;
}

export interface GraphSpec {
    steps: Record<string, WorkflowStep>;
    concurrency?: number;
    outputs?: Record<string, WorkflowOutput>;
}

export type GraphResult =
    | { status: 'completed'; outputs: Record<string, unknown> }
    | {
          status: 'errored';
          outputs: Record<string, unknown>;
          error: { code?: string; message?: string; stepId?: string };
      }
    | { status: 'canceled'; outputs: Record<string, unknown> };

export async function runGraph(
    graph: GraphSpec,
    deps: RunGraphDeps,
    pathPrefix = '',
): Promise<GraphResult> {
    const entries = Object.entries(graph.steps);
    if (entries.length === 0) {
        return { status: 'completed', outputs: {} };
    }

    // Normalize `next:` → `depends:`. `A.next = B` means B runs after A.
    const dependsOf = new Map<string, string[]>();
    for (const [id, step] of entries) {
        dependsOf.set(id, [...(step.depends ?? [])]);
    }
    for (const [id, step] of entries) {
        if (step.next && graph.steps[step.next]) {
            const list = dependsOf.get(step.next)!;
            if (!list.includes(id)) list.push(id);
        }
    }

    const dagError = validateDag(graph.steps, dependsOf);
    if (dagError) {
        return {
            status: 'errored',
            outputs: {},
            error: { code: 'invalid_dag', message: dagError },
        };
    }

    const outputs: Record<string, unknown> = {};
    const skipped = new Set<string>();
    const errored = new Set<string>();
    const remaining = new Map<string, WorkflowStep>(entries);
    const concurrency =
        graph.concurrency && graph.concurrency > 0 ? graph.concurrency : Infinity;
    let inflight = 0;
    let firstError: { stepId: string; code: string; message: string } | null = null;

    const ready = (id: string): boolean => {
        for (const dep of dependsOf.get(id) ?? []) {
            if (errored.has(dep)) return false;
            if (!(dep in outputs) && !skipped.has(dep)) return false;
        }
        return true;
    };

    const runNode = async (id: string, step: WorkflowStep): Promise<void> => {
        const nodeId = `${pathPrefix}${id}`;
        try {
            // skipIf — single-token expression preserves typed truthiness.
            if (step.skipIf) {
                const skipVal = substituteString(step.skipIf, deps.runInputs, outputs);
                if (isTruthy(skipVal)) {
                    skipped.add(id);
                    outputs[id] = { skipped: true, reason: step.skipIf };
                    return;
                }
            }

            const stepEmit = makeStepEmit(deps, nodeId);

            let result: HandlerResult;
            if (step.kind === 'group') {
                // Nested sub-DAG: same engine, own concurrency, prefixed
                // ids. DON'T pre-interpolate the children here — their
                // `${{ steps.X }}` references resolve against the GROUP's
                // own outputs inside the recursion, not the parent's.
                // (`${{ inputs.X }}` resolves the same either way since
                // runInputs threads down unchanged.)
                const group = step as GroupStep;
                const sub = await runGraph(
                    {
                        steps: group.steps,
                        ...(group.concurrency !== undefined
                            ? { concurrency: group.concurrency }
                            : {}),
                        ...(group.outputs !== undefined
                            ? { outputs: group.outputs }
                            : {}),
                    },
                    deps,
                    `${nodeId}/`,
                );
                result =
                    sub.status === 'completed'
                        ? { kind: 'completed', output: sub.outputs }
                        : {
                              kind: 'error',
                              code: sub.status === 'canceled' ? 'group_canceled' : (sub as { error: { code?: string } }).error.code ?? 'group_failed',
                              message:
                                  sub.status === 'canceled'
                                      ? 'group canceled'
                                      : (sub as { error: { message?: string } }).error.message ?? 'group failed',
                          };
            } else {
                // Leaf step: interpolate `${{ inputs }}` + `${{ steps }}`
                // against this graph's outputs, then dispatch.
                const resolved = resolveStepTemplates(step, deps.runInputs, outputs);
                const handler = deps.dispatcher.require(resolved.kind);
                const ctx: HandlerContext = {
                    runId: deps.runId,
                    stepId: nodeId,
                    principal: deps.principal,
                    routing: deps.routing,
                    runInputs: deps.runInputs,
                    annotations: deps.annotations,
                    signal: deps.signal,
                    log: deps.log,
                    emit: stepEmit,
                    ...(deps.workdirRoot !== undefined
                        ? { workdirRoot: deps.workdirRoot }
                        : {}),
                    ...(deps.dispatch !== undefined
                        ? { dispatch: deps.dispatch }
                        : {}),
                };
                result = await handler(resolved, ctx);
            }

            if (result.kind === 'paused_human') {
                // Inline HITL: block this node on the controller, let
                // independent siblings keep running. The resumed value
                // becomes the node's output — the DAG continues.
                const resumed = await deps.hitl.pauseForHuman({
                    runId: deps.runId,
                    stepId: nodeId,
                    schema: (result.schema as Record<string, unknown>) ?? {},
                    prompt: result.prompt,
                    routes: result.routes,
                    routing: deps.storeRouting,
                });
                outputs[id] = resumed;
                emitNodeCompleted(deps, nodeId, resumed);
                return;
            }

            if (result.kind === 'error') {
                if (step.fallback) {
                    const fb = substituteString(step.fallback, deps.runInputs, outputs);
                    if (fb !== undefined && fb !== null && fb !== '') {
                        outputs[id] = fb;
                        emitNodeCompleted(deps, nodeId, fb);
                        return;
                    }
                }
                errored.add(id);
                if (!firstError) {
                    firstError = { stepId: nodeId, code: result.code, message: result.message };
                }
                return;
            }

            const projected = projectStepOutput(result.output, stepEmit, deps.log, nodeId);
            outputs[id] = projected;
            emitNodeCompleted(deps, nodeId, projected);
        } catch (err) {
            errored.add(id);
            if (!firstError) {
                firstError = {
                    stepId: nodeId,
                    code: 'step_threw',
                    message: (err as Error).message,
                };
            }
        }
    };

    // Each node-completion calls `pump` directly (in its `.finally`),
    // so there are no lost wakeups — the classic wake-queue race
    // (signal fires before the waiter registers) can't happen.
    await new Promise<void>((resolveLoop) => {
        let done = false;
        const finish = (): void => {
            if (done) return;
            done = true;
            resolveLoop();
        };
        const pump = (): void => {
            if (done) return;
            if (deps.signal.aborted || firstError) {
                if (inflight === 0) finish();
                return;
            }
            for (const [id, step] of Array.from(remaining.entries())) {
                if (inflight >= concurrency) break;
                if (!ready(id)) continue;
                remaining.delete(id);
                inflight++;
                void runNode(id, step).finally(() => {
                    inflight--;
                    pump();
                });
            }
            if (inflight === 0 && remaining.size === 0) finish();
        };
        pump();
    });

    if (deps.signal.aborted && !firstError) {
        return { status: 'canceled', outputs };
    }
    if (firstError) {
        return { status: 'errored', outputs, error: firstError };
    }

    // Aggregate outputs if the graph declares bindings; else the raw
    // per-step map (the default — preserves the route `.main` unwrap +
    // every existing consumer's shape).
    if (graph.outputs) {
        return {
            status: 'completed',
            outputs: computeOutputs(graph.outputs, deps.runInputs, outputs),
        };
    }
    return { status: 'completed', outputs };
}

// ─── fact-event emit ────────────────────────────────────────────────────────

function makeStepEmit(deps: RunGraphDeps, nodeId: string): EmitFactEvent {
    return (raw) => {
        const ts = raw.ts ?? Date.now();
        const { ts: _t, ...rest } = raw;
        deps.emitFact({
            runId: deps.runId,
            seq: deps.nextSeq(deps.runId),
            type: raw.type,
            payload: { stepId: nodeId, ...rest } as Record<string, unknown>,
            ts,
            routing: deps.storeRouting,
        });
    };
}

function emitNodeCompleted(deps: RunGraphDeps, nodeId: string, output: unknown): void {
    deps.emitFact({
        runId: deps.runId,
        seq: deps.nextSeq(deps.runId),
        type: 'fact.node_completed',
        payload: { nodeId, output },
        ts: Date.now(),
        routing: deps.storeRouting,
    });
}

// ─── DAG validation ───────────────────────────────────────────────────────

function validateDag(
    steps: Record<string, WorkflowStep>,
    dependsOf: Map<string, string[]>,
): string | null {
    const ids = new Set(Object.keys(steps));
    for (const [id, deps] of dependsOf) {
        for (const dep of deps) {
            if (!ids.has(dep)) return `step "${id}" depends on unknown step "${dep}"`;
            if (dep === id) return `step "${id}" depends on itself`;
        }
    }
    // Kahn's algorithm for cycle detection.
    const inDegree = new Map<string, number>();
    for (const id of ids) inDegree.set(id, (dependsOf.get(id) ?? []).length);
    const adj = new Map<string, string[]>();
    for (const id of ids) adj.set(id, []);
    for (const [id, deps] of dependsOf) {
        for (const dep of deps) adj.get(dep)!.push(id);
    }
    const queue: string[] = [];
    for (const [id, d] of inDegree) if (d === 0) queue.push(id);
    let visited = 0;
    while (queue.length) {
        const id = queue.shift()!;
        visited++;
        for (const down of adj.get(id) ?? []) {
            const d = (inDegree.get(down) ?? 0) - 1;
            inDegree.set(down, d);
            if (d === 0) queue.push(down);
        }
    }
    return visited === ids.size ? null : 'step graph has a cycle';
}

// ─── interpolation ──────────────────────────────────────────────────────────

const TOKEN_RE = /\$\{\{\s*([^}]+?)\s*\}\}/g;

function resolveStepTemplates(
    step: WorkflowStep,
    inputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
): WorkflowStep {
    return walkValue(step, inputs, stepOutputs) as WorkflowStep;
}

function walkValue(
    value: unknown,
    inputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
): unknown {
    if (typeof value === 'string') return substituteString(value, inputs, stepOutputs);
    if (Array.isArray(value)) return value.map((v) => walkValue(v, inputs, stepOutputs));
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = walkValue(v, inputs, stepOutputs);
        }
        return out;
    }
    return value;
}

function substituteString(
    s: string,
    inputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
): unknown {
    const trimmed = s.trim();
    const full = /^\$\{\{\s*([^}]+?)\s*\}\}$/.exec(trimmed);
    if (full) {
        // Whole string is one token → return the typed value (object,
        // boolean, array, …) so `skipIf` truthiness + structured
        // handoff work.
        const v = resolveExpression(full[1]!, inputs, stepOutputs);
        return v ?? '';
    }
    return s.replace(TOKEN_RE, (_m, expr: string) => {
        const v = resolveExpression(expr, inputs, stepOutputs);
        if (v === undefined || v === null) return '';
        return typeof v === 'string' ? v : JSON.stringify(v);
    });
}

/**
 * Resolve a `${{ }}` expression against the run inputs + prior step
 * outputs. Shapes:
 *   - `inputs.X.Y`            → inputs[X][Y]
 *   - `steps.<id>.outputs.X`  → stepOutputs[id][X]
 *   - `steps.<id>`            → stepOutputs[id]  (whole output)
 *   - `steps.<id>.X`          → stepOutputs[id][X]  (shorthand)
 */
export function resolveExpression(
    expr: string,
    inputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
): unknown {
    const parts = expr.split('.').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return undefined;
    if (parts[0] === 'inputs') return resolvePath(inputs, parts.slice(1));
    if (parts[0] === 'steps') {
        if (parts.length < 2) return undefined;
        const stepOutput = stepOutputs[parts[1]!];
        if (stepOutput === undefined) return undefined;
        if (parts.length === 2) return stepOutput;
        if (parts[2] !== 'outputs') return resolvePath(stepOutput, parts.slice(2));
        return resolvePath(stepOutput, parts.slice(3));
    }
    return undefined;
}

function resolvePath(obj: unknown, path: string[]): unknown {
    let cur: unknown = obj;
    for (const p of path) {
        if (cur === undefined || cur === null || typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}

function computeOutputs(
    bindings: Record<string, WorkflowOutput>,
    inputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, binding] of Object.entries(bindings)) {
        // `from` is either a `${{ }}` expression OR a bare step id (or
        // array of ids for dashboard-shape aggregation). Resolve both.
        if (Array.isArray(binding.from)) {
            out[key] = binding.from.map((id) => stepOutputs[id]);
            continue;
        }
        const expr = binding.from.trim();
        const full = /^\$\{\{\s*([^}]+?)\s*\}\}$/.exec(expr);
        if (full) {
            out[key] = resolveExpression(full[1]!, inputs, stepOutputs);
        } else {
            // Bare step id → that step's output, optionally `.pick`ed.
            const base = stepOutputs[expr];
            out[key] = binding.pick ? resolvePath(base, binding.pick.split('.')) : base;
        }
    }
    return out;
}

function isTruthy(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
    if (typeof value === 'string') return value.length > 0 && value !== 'false';
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
}
