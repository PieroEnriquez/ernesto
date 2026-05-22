/**
 * Internal IR for the step-graph walker. The walker doesn't need much
 * beyond the source shape; this file exists so the walker has a
 * focused contract instead of importing the whole declaration type.
 */

import type { WorkflowDeclaration, WorkflowStep } from '../../workflows/types';

/** Compiled step — for now just the source step plus its id, but the
 *  type exists so future improvements (template pre-resolution, edge
 *  precomputation) have a home. */
export interface CompiledStep {
    id: string;
    step: WorkflowStep;
}

export function compileSteps(decl: WorkflowDeclaration): CompiledStep[] {
    return Object.entries(decl.steps ?? {}).map(([id, step]) => ({
        id,
        step,
    }));
}

export type { WorkflowDeclaration, WorkflowStep };
