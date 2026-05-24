/**
 * `parallel` step kind — scatter-gather over a map of branches.
 *
 * Each branch is itself a {@link WorkflowStep} dispatched through the
 * same {@link HandlerDispatcher} the walker uses. Branch outputs zip
 * into a `{ [branchKey]: <output> }` map exposed as the parallel step's
 * own output, so the universal render-manifest projector at the walker
 * level still applies (e.g. a `render` field on the merged result fires
 * components against the parent stepId).
 *
 * Per-branch output is *also* projected here: if a branch returns
 * `{ ..., render: [...] }`, components emit during that branch's
 * dispatch under the parent's stepId. This keeps the substrate uniform
 * — wherever data lives, the manifest convention works.
 *
 * Constraints (intentional, not accidental):
 *
 *   - `paused_human` from a branch is an error. HITL belongs at the
 *     workflow level; pausing one branch while others run is a
 *     soundness hole we don't open in v1.
 *   - First branch failure rejects the whole step. Siblings keep
 *     running but their outputs are discarded. Add abort-on-error
 *     wiring later if a real use case demands it.
 *   - The dispatcher reference is captured at factory time — register
 *     `parallel` after the other kinds, or rely on lookups happening
 *     at dispatch time (which is what `require` does).
 */

import type { ParallelStep } from '../../workflows/types';
import type { HandlerDispatcher } from '../dispatch';
import type {
    EmitFactEvent,
    EmitFactEventInput,
    HandlerContext,
    HandlerResult,
    StepKindHandler,
} from '../types/handler';
import { projectStepOutput } from './render-projection';

export function makeParallelHandler(
    dispatcher: HandlerDispatcher,
): StepKindHandler<ParallelStep> {
    return async (step, ctx): Promise<HandlerResult> => {
        const entries = Object.entries(step.branches);
        if (entries.length === 0) {
            return { kind: 'completed', output: {} };
        }

        const branchEmit: EmitFactEvent | undefined = ctx.emit
            ? (input: EmitFactEventInput) => ctx.emit!(input)
            : undefined;

        const tasks = entries.map(async ([key, branch]) => {
            const branchHandler = dispatcher.require(branch.kind);
            const branchCtx: HandlerContext = {
                ...ctx,
                ...(branchEmit ? { emit: branchEmit } : {}),
            };
            const result = await branchHandler(branch, branchCtx);
            if (result.kind === 'paused_human') {
                throw new BranchPausedError(key);
            }
            if (result.kind === 'error') {
                throw new BranchFailedError(key, result);
            }
            const projected = branchEmit
                ? projectStepOutput(result.output, branchEmit, ctx.log, ctx.stepId)
                : result.output;
            return [key, projected] as const;
        });

        try {
            const settled = await Promise.all(tasks);
            return {
                kind: 'completed',
                output: Object.fromEntries(settled),
            };
        } catch (err) {
            if (err instanceof BranchFailedError) {
                return {
                    kind: 'error',
                    code: err.result.code,
                    message: `branch "${err.branchKey}": ${err.result.message}`,
                    details: err.result.details,
                };
            }
            if (err instanceof BranchPausedError) {
                return {
                    kind: 'error',
                    code: 'parallel_branch_paused',
                    message:
                        `branch "${err.branchKey}" requested human input. ` +
                        '`input` steps must live at the workflow level, ' +
                        'not inside a `parallel` block.',
                };
            }
            throw err;
        }
    };
}

class BranchFailedError extends Error {
    constructor(
        readonly branchKey: string,
        readonly result: Extract<HandlerResult, { kind: 'error' }>,
    ) {
        super(`branch ${branchKey} failed`);
    }
}

class BranchPausedError extends Error {
    constructor(readonly branchKey: string) {
        super(`branch ${branchKey} paused for human`);
    }
}
