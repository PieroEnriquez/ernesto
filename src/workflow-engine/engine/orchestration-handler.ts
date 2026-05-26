/**
 * `orchestration` step kind — declarative DAG composition.
 *
 * Replaces hand-rolled multi-step pipelines (like the autofill
 * `orchestrate.ts` from product-autofill) with a substrate-handled
 * primitive:
 *
 *   - Topological execution of child steps based on `depends:`.
 *   - Parallel dispatch of independent children up to `concurrency`.
 *   - `${{ steps.<id>.outputs.<path> }}` interpolation in child inputs.
 *   - `${{ inputs.<name> }}` interpolation against the orchestration's
 *     own inputs (threaded from the parent dispatch).
 *   - `skipIf:` predicate evaluation — truthy ⇒ skip without dispatch.
 *   - `fallback:` expression — replaces step error with fallback value.
 *   - Aggregated output map via `outputs:` bindings.
 *   - First-error fails the orchestration (siblings may still terminate
 *     in flight; v1 acceptable).
 *   - `paused_human` from a child propagates up — the orchestration
 *     pauses, the walker's HITL controller handles it, the resume
 *     value becomes the child's output.
 *
 * Composes recursively — an orchestration can contain another
 * orchestration as a child. The DAG of the inner one runs inside the
 * outer step's lifecycle, with its own concurrency budget.
 */

import type {
    OrchestrationStep,
    OrchestrationChild,
    WorkflowStep,
} from '../../workflows/types';
import type { HandlerDispatcher } from '../dispatch';
import type {
    EmitFactEvent,
    EmitFactEventInput,
    HandlerContext,
    HandlerResult,
    StepKindHandler,
} from '../types/handler';
import { projectStepOutput } from './render-projection';

export function makeOrchestrationHandler(
    dispatcher: HandlerDispatcher,
): StepKindHandler<OrchestrationStep> {
    return async (step, ctx): Promise<HandlerResult> => {
        const entries = Object.entries(step.steps);
        if (entries.length === 0) {
            return { kind: 'completed', output: {} };
        }

        // Validate DAG: detect cycles, missing depends, dead refs.
        const validation = validateDag(step.steps);
        if (validation.kind === 'error') {
            return {
                kind: 'error',
                code: 'orchestration_invalid_dag',
                message: validation.message,
            };
        }

        const childEmit: EmitFactEvent | undefined = ctx.emit
            ? (input: EmitFactEventInput) => ctx.emit!(input)
            : undefined;

        // The accumulating outputs map, keyed by child step id.
        // `undefined` means "not yet completed"; absence means skipped.
        const outputs: Record<string, unknown> = {};
        const skipped = new Set<string>();
        const errored = new Set<string>();

        // The orchestration's `${{ inputs.X }}` resolution uses the
        // run's top-level inputs (the `inputs` argument to
        // `dispatch(...)`). The walker threads this through every
        // step's `ctx.runInputs`. The orchestration step's own
        // optional `inputs:` field (rarely used) is overlaid on top
        // — interpolated value if it's a `${{ }}` token, else literal.
        const stepLevelInputs =
            (step as unknown as { inputs?: Record<string, unknown> }).inputs ?? {};
        const orchestrationInputs: Record<string, unknown> = { ...ctx.runInputs };
        for (const [k, v] of Object.entries(stepLevelInputs)) {
            if (typeof v === 'string') {
                orchestrationInputs[k] = substituteString(v, ctx.runInputs, {});
            } else {
                orchestrationInputs[k] = v;
            }
        }

        // Build dependency graph + reverse adjacency for runnability checks.
        const remaining = new Map<string, OrchestrationChild>(entries);
        const dependents = new Map<string, string[]>();
        for (const [id, child] of entries) {
            dependents.set(id, []);
            for (const dep of child.depends ?? []) {
                if (!dependents.has(dep)) dependents.set(dep, []);
                dependents.get(dep)!.push(id);
            }
        }

        // Semaphore for `concurrency` cap. When unset, no cap — all
        // ready steps fire at once.
        const concurrency = step.concurrency && step.concurrency > 0 ? step.concurrency : Infinity;
        let inflight = 0;

        // Settle when no more children remain (all done or skipped).
        const settle = createDeferred<HandlerResult>();
        const wakeQueue: Array<() => void> = [];
        const wake = () => {
            while (wakeQueue.length) wakeQueue.shift()!();
        };

        let firstError: { stepId: string; code: string; message: string } | null = null;
        let pendingPause: { prompt: string; routes: string[]; schema?: unknown } | null = null;

        const ready = (childId: string, child: OrchestrationChild): boolean => {
            for (const dep of child.depends ?? []) {
                if (errored.has(dep)) return false;            // dep failed → this can't run
                if (!(dep in outputs) && !skipped.has(dep)) return false; // not yet
            }
            return true;
        };

        const tryDispatch = async (): Promise<void> => {
            if (firstError || pendingPause) {
                // Stop scheduling new work — let inflight drain then settle.
                if (inflight === 0) settleTerminal();
                return;
            }
            for (const [id, child] of Array.from(remaining.entries())) {
                if (inflight >= concurrency) break;
                if (!ready(id, child)) continue;

                // Pop from remaining + run.
                remaining.delete(id);

                // skipIf evaluation — the field is a token string like
                // `${{ steps.fetch.outputs.ok }}` OR a bare path
                // expression. `substituteString` handles both forms;
                // a single-token expression returns the typed value
                // (boolean/object/etc.), preserving truthiness checks.
                if (child.skipIf) {
                    const skipExpr = substituteString(
                        child.skipIf,
                        orchestrationInputs,
                        outputs,
                    );
                    if (isTruthy(skipExpr)) {
                        skipped.add(id);
                        outputs[id] = { skipped: true, reason: child.skipIf };
                        emitChildSkipped(ctx, id, child.skipIf);
                        // Allow dependents to become ready.
                        continue;
                    }
                }

                inflight++;
                runChild(id, child).finally(() => {
                    inflight--;
                    wake();
                });
            }
            if (inflight === 0 && remaining.size === 0) {
                settleTerminal();
            }
        };

        const runChild = async (
            id: string,
            child: OrchestrationChild,
        ): Promise<void> => {
            try {
                const childStep = resolveStepTemplates(
                    child.step,
                    orchestrationInputs,
                    outputs,
                );
                const childHandler = dispatcher.require(childStep.kind);
                const childCtx: HandlerContext = {
                    ...ctx,
                    stepId: `${ctx.stepId}/${id}`,
                    ...(childEmit ? { emit: childEmit } : {}),
                };
                const result = await childHandler(childStep, childCtx);

                if (result.kind === 'paused_human') {
                    pendingPause = {
                        prompt: result.prompt,
                        routes: result.routes,
                        ...(result.schema !== undefined ? { schema: result.schema } : {}),
                    };
                    return;
                }

                if (result.kind === 'error') {
                    // Try fallback expression if declared.
                    if (child.fallback) {
                        const fallbackValue = substituteString(
                            child.fallback,
                            orchestrationInputs,
                            outputs,
                        );
                        if (fallbackValue !== undefined && fallbackValue !== null && fallbackValue !== '') {
                            outputs[id] = fallbackValue;
                            return;
                        }
                    }
                    errored.add(id);
                    if (!firstError) {
                        firstError = {
                            stepId: id,
                            code: result.code,
                            message: result.message,
                        };
                    }
                    return;
                }

                outputs[id] = projectStepOutput(
                    result.output,
                    childEmit,
                    ctx.log,
                    `${ctx.stepId}/${id}`,
                );
            } catch (err) {
                errored.add(id);
                if (!firstError) {
                    firstError = {
                        stepId: id,
                        code: 'orchestration_child_threw',
                        message: (err as Error).message,
                    };
                }
            }
        };

        function settleTerminal() {
            if (settle.settled) return;

            if (firstError) {
                settle.resolve({
                    kind: 'error',
                    code: firstError.code,
                    message: `orchestration step "${firstError.stepId}" failed: ${firstError.message}`,
                    details: { stepId: firstError.stepId },
                });
                return;
            }
            if (pendingPause) {
                settle.resolve({
                    kind: 'paused_human',
                    prompt: pendingPause.prompt,
                    routes: pendingPause.routes,
                    ...(pendingPause.schema !== undefined ? { schema: pendingPause.schema } : {}),
                });
                return;
            }

            // Compute terminal output map.
            const computed = step.outputs
                ? computeOrchestrationOutputs(step.outputs, orchestrationInputs, outputs)
                : { steps: outputs };

            settle.resolve({ kind: 'completed', output: computed });
        }

        // Kick the loop. tryDispatch fires every time a child terminates
        // (via the wake mechanism); each wake re-runs tryDispatch which
        // tops up the ready set and dispatches up to `concurrency`.
        const loop = (async () => {
            await tryDispatch();
            while (!settle.settled) {
                await new Promise<void>((r) => wakeQueue.push(r));
                await tryDispatch();
            }
        })();

        const result = await settle.promise;
        await loop; // ensure no dangling
        return result;
    };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emitChildSkipped(ctx: HandlerContext, childId: string, reason: string): void {
    // Skips don't have a dedicated fact-event type yet; surface as a
    // node_completed with a `skipped` marker payload so reducers and
    // tier ports can render "step X skipped because <reason>".
    if (!ctx.emit) return;
    // Reuse fact.component with a status component for visibility.
    ctx.emit({
        type: 'fact.component',
        component: {
            kind: 'status',
            props: { text: `Skipped (${reason})`, level: 'info' },
            slotId: `orchestration-skip-${childId}`,
        } as any,
    });
}

/** Validate the DAG: no missing depends, no cycles. */
function validateDag(
    steps: Record<string, OrchestrationChild>,
): { kind: 'ok' } | { kind: 'error'; message: string } {
    const ids = new Set(Object.keys(steps));
    for (const [id, child] of Object.entries(steps)) {
        for (const dep of child.depends ?? []) {
            if (!ids.has(dep)) {
                return {
                    kind: 'error',
                    message: `step "${id}" depends on unknown step "${dep}"`,
                };
            }
            if (dep === id) {
                return {
                    kind: 'error',
                    message: `step "${id}" depends on itself`,
                };
            }
        }
    }
    // Cycle detection via Kahn's algorithm.
    const inDegree = new Map<string, number>();
    for (const id of ids) inDegree.set(id, 0);
    for (const child of Object.values(steps)) {
        for (const dep of child.depends ?? []) {
            inDegree.set(dep, (inDegree.get(dep) ?? 0));
        }
    }
    // Build reverse: dep → dependents
    const adj = new Map<string, string[]>();
    for (const id of ids) adj.set(id, []);
    for (const [id, child] of Object.entries(steps)) {
        for (const dep of child.depends ?? []) {
            adj.get(dep)!.push(id);
            inDegree.set(id, (inDegree.get(id) ?? 0) + 1);
        }
    }
    const queue: string[] = [];
    for (const [id, d] of inDegree) if (d === 0) queue.push(id);
    let visited = 0;
    while (queue.length) {
        const id = queue.shift()!;
        visited++;
        for (const downstream of adj.get(id) ?? []) {
            const d = (inDegree.get(downstream) ?? 0) - 1;
            inDegree.set(downstream, d);
            if (d === 0) queue.push(downstream);
        }
    }
    if (visited !== ids.size) {
        return { kind: 'error', message: 'orchestration DAG has a cycle' };
    }
    return { kind: 'ok' };
}

/** Resolve a step's templated fields against the orchestration's
 *  inputs + prior step outputs. */
function resolveStepTemplates(
    step: WorkflowStep,
    inputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
): WorkflowStep {
    return walkValue(step, inputs, stepOutputs) as WorkflowStep;
}

const TOKEN_RE = /\$\{\{\s*([^}]+?)\s*\}\}/g;

function walkValue(
    value: unknown,
    inputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
): unknown {
    if (typeof value === 'string') {
        return substituteString(value, inputs, stepOutputs);
    }
    if (Array.isArray(value)) {
        return value.map((v) => walkValue(v, inputs, stepOutputs));
    }
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
    // If the entire string is a single token, return the *value* (preserving
    // type — object, number, array, …). Else substitute inline as string.
    const trimmed = s.trim();
    const fullMatch = /^\$\{\{\s*([^}]+?)\s*\}\}$/.exec(trimmed);
    if (fullMatch) {
        const val = resolveExpression(fullMatch[1]!, inputs, stepOutputs);
        return val ?? '';
    }
    return s.replace(TOKEN_RE, (_m, expr: string) => {
        const v = resolveExpression(expr, inputs, stepOutputs);
        if (v === undefined || v === null) return '';
        return typeof v === 'string' ? v : JSON.stringify(v);
    });
}

/** Resolve an interpolation expression against the orchestration's
 *  inputs + step outputs map.
 *
 *  Supported shapes:
 *    - `inputs.X`               → inputs[X]
 *    - `inputs.X.Y.Z`           → inputs[X][Y][Z]
 *    - `steps.<id>.outputs.X.Y` → stepOutputs[id][X][Y]
 *    - `steps.<id>.outputs`     → stepOutputs[id]
 */
export function resolveExpression(
    expr: string,
    inputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
): unknown {
    const parts = expr.split('.').map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) return undefined;

    if (parts[0] === 'inputs') {
        return resolvePath(inputs, parts.slice(1));
    }
    if (parts[0] === 'steps') {
        if (parts.length < 2) return undefined;
        const stepId = parts[1]!;
        const stepOutput = stepOutputs[stepId];
        if (stepOutput === undefined) return undefined;
        // Allow `steps.X` (full output) or `steps.X.outputs.Y` (path).
        if (parts.length === 2) return stepOutput;
        if (parts[2] !== 'outputs') {
            // `steps.X.Y` shorthand — treat as `steps.X.outputs.Y`.
            return resolvePath(stepOutput, parts.slice(2));
        }
        return resolvePath(stepOutput, parts.slice(3));
    }
    return undefined;
}

function resolvePath(obj: unknown, path: string[]): unknown {
    let cur: unknown = obj;
    for (const p of path) {
        if (cur === undefined || cur === null) return undefined;
        if (typeof cur !== 'object') return undefined;
        cur = (cur as Record<string, unknown>)[p];
    }
    return cur;
}

function computeOrchestrationOutputs(
    bindings: NonNullable<OrchestrationStep['outputs']>,
    inputs: Record<string, unknown>,
    stepOutputs: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, binding] of Object.entries(bindings)) {
        const expr = binding.from.trim();
        const fullMatch = /^\$\{\{\s*([^}]+?)\s*\}\}$/.exec(expr);
        if (fullMatch) {
            out[key] = resolveExpression(fullMatch[1]!, inputs, stepOutputs);
        } else {
            // Pass-through literal (rare).
            out[key] = binding.from;
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

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (v: T) => void;
    settled: boolean;
}

function createDeferred<T>(): Deferred<T> {
    const d: Partial<Deferred<T>> = { settled: false };
    d.promise = new Promise<T>((res) => {
        d.resolve = (v: T) => {
            if (d.settled) return;
            d.settled = true;
            res(v);
        };
    });
    return d as Deferred<T>;
}
