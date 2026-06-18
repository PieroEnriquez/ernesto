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

import { randomUUID } from 'node:crypto';
import type { WorkflowStep, WorkflowOutput, GroupStep } from '../../workflows/types';
import type { HandlerDispatcher } from '../dispatch';
import type { EngineLogger, EmitFactEvent, HandlerContext, HandlerResult, HandlerRouting } from '../types/handler';
import type { FactEvent } from '../types/event';
import type { Principal } from '../principal';
import type { ParkedPause } from '../store/port';
import type { WorkspaceView } from '../../route/define-route';
import { projectStepOutput } from './render-projection';

/** Resume seed — supplied by the runner when re-entering a paused run.
 *  Keys are FULL node ids (path-prefixed). The seeded run does NOT
 *  re-execute completed/skipped steps; it resolves the parked step
 *  with the submitted value and continues the DAG from there.
 *
 *   - `outputs`  — completed step outputs from the prior walk.
 *   - `skipped`  — node ids skipped in the prior walk.
 *   - `resolved` — the pause(s) being resumed now → their submitted
 *     value. The engine emits `fact.node_completed` for these.
 *   - `parked`   — pauses that stay parked (multi-pause runs): re-held
 *     as-is without re-running their handler, so the run can re-pause
 *     on them if downstream steps still depend on them. */
export interface GraphSeed {
    outputs: Record<string, unknown>;
    skipped: string[];
    resolved: Record<string, unknown>;
    parked?: ParkedPause[];
}

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
    log: EngineLogger;
    signal: AbortSignal;
    runId: string;
    principal: Principal;
    routing: HandlerRouting;
    runInputs: Record<string, unknown>;
    annotations: Readonly<Record<string, unknown>>;
    workdirRoot?: string;
    workspaceView?: WorkspaceView;
    /** Low-level fact emit (bus + store append). The scheduler wraps
     *  it per-node to inject the path-qualified stepId. */
    emitFact: (event: FactEvent) => void;
    nextSeq: (runId: string) => number;
    /** Routing projected into the store/event-row shape. */
    storeRouting: Record<string, unknown>;
    /** Set when re-entering a paused run — pre-seeds completed/skipped
     *  steps and resolves the parked step(s). Absent on first walk. */
    seed?: GraphSeed;
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
    | { status: 'canceled'; outputs: Record<string, unknown> }
    | {
          /** One or more steps parked on a step-level pause. The run is
           *  NOT terminal — `resumeRun` continues it. `partialOutputs`
           *  + `skippedNodeIds` are FULL-node-id keyed so a nested
           *  group's partial progress survives into the resume seed. */
          status: 'paused';
          outputs: Record<string, unknown>;
          partialOutputs: Record<string, unknown>;
          skippedNodeIds: string[];
          paused: ParkedPause[];
      };

export async function runGraph(graph: GraphSpec, deps: RunGraphDeps, pathPrefix = ''): Promise<GraphResult> {
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
    const concurrency = graph.concurrency && graph.concurrency > 0 ? graph.concurrency : Infinity;
    let inflight = 0;
    let firstError: { stepId: string; code: string; message: string } | null = null;

    // Steps parked on a step-level pause this walk (leaf pauses + pauses
    // bubbled up from a nested group). A non-empty list once the graph
    // drains settles it 'paused' instead of 'completed'.
    const pausedSteps: ParkedPause[] = [];
    // Partial progress bubbled up from a paused nested group — already
    // FULL-node-id keyed so the resume seed re-enters the sub-DAG.
    const nestedPartials: Record<string, unknown> = {};
    const nestedSkipped: string[] = [];

    // Resume seed: pre-satisfy completed/skipped steps and resolve the
    // pause(s) being resumed now — all WITHOUT re-running their handlers
    // (re-running would repeat side effects).
    if (deps.seed) {
        const seed = deps.seed;
        for (const [id] of entries) {
            const nodeId = `${pathPrefix}${id}`;
            if (Object.prototype.hasOwnProperty.call(seed.resolved, nodeId)) {
                // The pause being resumed — its submitted value becomes
                // the node output; emit completion so the DAG advances.
                outputs[id] = seed.resolved[nodeId];
                remaining.delete(id);
                emitNodeCompleted(deps, nodeId, seed.resolved[nodeId]);
            } else if (Object.prototype.hasOwnProperty.call(seed.outputs, nodeId)) {
                // Completed in the prior walk — restore output, no re-emit.
                outputs[id] = seed.outputs[nodeId];
                remaining.delete(id);
            } else if (seed.skipped.includes(nodeId)) {
                skipped.add(id);
                outputs[id] = { skipped: true, reason: 'resumed-skip' };
                remaining.delete(id);
            }
        }
        // Pauses that stay parked (multi-pause runs): re-hold the ones
        // owned at THIS level as-is, so the run re-pauses on them without
        // re-running their handler. Deeper pauses re-hold inside their
        // group's recursion (which receives the same seed).
        for (const p of seed.parked ?? []) {
            if (!p.stepId.startsWith(pathPrefix)) continue;
            const localId = p.stepId.slice(pathPrefix.length);
            if (!localId.includes('/') && remaining.has(localId)) {
                pausedSteps.push(p);
                remaining.delete(localId);
            }
        }
    }

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
                        ...(group.concurrency !== undefined ? { concurrency: group.concurrency } : {}),
                        ...(group.outputs !== undefined ? { outputs: group.outputs } : {}),
                    },
                    deps,
                    `${nodeId}/`,
                );
                if (sub.status === 'paused') {
                    // A step inside the group parked. Bubble it up: this
                    // group node is itself parked (left un-set in outputs),
                    // carrying the sub-DAG's partial progress so the resume
                    // seed re-enters the group and continues from the pause.
                    for (const p of sub.paused) pausedSteps.push(p);
                    Object.assign(nestedPartials, sub.partialOutputs);
                    for (const s of sub.skippedNodeIds) nestedSkipped.push(s);
                    return;
                }
                result =
                    sub.status === 'completed'
                        ? { kind: 'completed', output: sub.outputs }
                        : {
                              kind: 'error',
                              code:
                                  sub.status === 'canceled'
                                      ? 'group_canceled'
                                      : ((sub as { error: { code?: string } }).error.code ?? 'group_failed'),
                              message:
                                  sub.status === 'canceled'
                                      ? 'group canceled'
                                      : ((sub as { error: { message?: string } }).error.message ?? 'group failed'),
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
                    ...(deps.workdirRoot !== undefined ? { workdirRoot: deps.workdirRoot } : {}),
                    ...(deps.workspaceView !== undefined ? { workspaceView: deps.workspaceView } : {}),
                    ...(deps.dispatch !== undefined ? { dispatch: deps.dispatch } : {}),
                };
                result = await handler(resolved, ctx);
            }

            if (result.kind === 'paused_human' || result.kind === 'paused_signal') {
                // Step-level pause: park the node — DON'T block. Other
                // ready siblings keep running; the parked node's output
                // stays unset so its dependents aren't ready, and the
                // graph settles 'paused' once nothing else can progress.
                // `resumeRun` re-enters from durable state (no in-heap
                // promise), so the pause survives a pod restart.
                parkStep(deps, nodeId, result, pausedSteps);
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
            if (inflight === 0) {
                if (remaining.size === 0) {
                    finish();
                    return;
                }
                // Nothing in flight, work remains — can anything start? If
                // not, the run is stuck on a pause (or blocked by an
                // errored dep, which the firstError guard also catches).
                let anyReady = false;
                for (const id of remaining.keys()) {
                    if (ready(id)) {
                        anyReady = true;
                        break;
                    }
                }
                if (!anyReady) finish();
            }
        };
        pump();
    });

    if (deps.signal.aborted && !firstError) {
        return { status: 'canceled', outputs };
    }
    if (firstError) {
        return { status: 'errored', outputs, error: firstError };
    }
    if (pausedSteps.length > 0) {
        // Project this level's completed outputs to FULL node ids and
        // merge the nested-group partials already in that shape, so the
        // runner persists one flat resume seed across nesting levels.
        const partialOutputs: Record<string, unknown> = { ...nestedPartials };
        for (const [id, val] of Object.entries(outputs)) {
            if (skipped.has(id)) continue;
            partialOutputs[`${pathPrefix}${id}`] = val;
        }
        const skippedNodeIds = [...nestedSkipped, ...Array.from(skipped).map((id) => `${pathPrefix}${id}`)];
        return {
            status: 'paused',
            outputs,
            partialOutputs,
            skippedNodeIds,
            paused: pausedSteps,
        };
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

/** Record a step-level pause and emit its fact event. No in-heap
 *  promise — the run parks and `resumeRun` re-enters from durable
 *  state. The `fact.run_paused_human` payload mirrors the legacy HITL
 *  emit (`{ nodeId, text, routes, promptId }` + `routing.inputSchema`)
 *  so existing subscribers/pause-registry resolve it unchanged. */
function parkStep(
    deps: RunGraphDeps,
    nodeId: string,
    result: Extract<HandlerResult, { kind: 'paused_human' | 'paused_signal' }>,
    pausedSteps: ParkedPause[],
): void {
    const promptId = randomUUID();
    if (result.kind === 'paused_human') {
        const schema = (result.schema as Record<string, unknown>) ?? {};
        pausedSteps.push({
            stepId: nodeId,
            promptId,
            kind: 'human',
            schema,
            prompt: result.prompt,
            routes: result.routes,
            ...(result.resumePrompt !== undefined ? { resumePrompt: result.resumePrompt } : {}),
        });
        deps.emitFact({
            runId: deps.runId,
            seq: deps.nextSeq(deps.runId),
            type: 'fact.run_paused_human',
            payload: { nodeId, text: result.prompt, routes: result.routes, promptId },
            ts: Date.now(),
            routing: { ...deps.storeRouting, inputSchema: schema },
        });
        return;
    }
    // paused_signal — no user prompt; a worker watching `signalKey`
    // resumes the run on an external state change.
    const schema = result.schema as Record<string, unknown> | undefined;
    pausedSteps.push({
        stepId: nodeId,
        promptId,
        kind: 'signal',
        signalKey: result.signalKey,
        ...(schema !== undefined ? { schema } : {}),
        ...(result.resumePrompt !== undefined ? { resumePrompt: result.resumePrompt } : {}),
    });
    deps.emitFact({
        runId: deps.runId,
        seq: deps.nextSeq(deps.runId),
        type: 'fact.run_paused_signal',
        payload: { nodeId, promptId, signalKey: result.signalKey },
        ts: Date.now(),
        routing: { ...deps.storeRouting, ...(schema ? { inputSchema: schema } : {}) },
    });
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

function validateDag(steps: Record<string, WorkflowStep>, dependsOf: Map<string, string[]>): string | null {
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

function resolveStepTemplates(step: WorkflowStep, inputs: Record<string, unknown>, stepOutputs: Record<string, unknown>): WorkflowStep {
    return walkValue(step, inputs, stepOutputs) as WorkflowStep;
}

function walkValue(value: unknown, inputs: Record<string, unknown>, stepOutputs: Record<string, unknown>): unknown {
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

function substituteString(s: string, inputs: Record<string, unknown>, stepOutputs: Record<string, unknown>): unknown {
    const trimmed = s.trim();
    const full = /^\$\{\{\s*([^}]+?)\s*\}\}$/.exec(trimmed);
    if (full) {
        // Whole string is one token → return the typed value (object,
        // boolean, array, undefined, …) so:
        //   - `skipIf` truthiness works
        //   - structured handoff preserves type
        //   - downstream zod schemas with `.default(...)` fire when the
        //     resolved value is undefined (legacy coercion to '' here
        //     replaced an unresolved reference with an empty string,
        //     which then failed type checks instead of taking the default).
        return resolveExpression(full[1]!, inputs, stepOutputs);
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
export function resolveExpression(expr: string, inputs: Record<string, unknown>, stepOutputs: Record<string, unknown>): unknown {
    const parts = expr
        .split('.')
        .map((p) => p.trim())
        .filter(Boolean);
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
