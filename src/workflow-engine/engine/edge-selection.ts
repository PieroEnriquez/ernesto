/**
 * Edge selection — picks the next step id from a completed step's
 * `next` / `on` declarations + the event the handler emitted.
 *
 * For Phase 0 the walker uses a flat declaration-order iteration that
 * does NOT consult edges; this module exists as the seam for the
 * follow-on where the walker becomes truly graph-driven. The two
 * helpers below are clean-room writes against the schema contract:
 *
 *   - `next: string` — default outgoing edge.
 *   - `on: { [event]: stepId }` — conditional edges keyed by handler
 *      event ('completed', or a custom event name a route-step
 *      returns).
 *   - `outputs` or `outputs.<name>` — terminal sink.
 */

import type { WorkflowStep } from '../../workflows/types';

export const TERMINAL_OUTPUTS_PREFIX = 'outputs';

/** True if the destination id terminates the run. */
export function isTerminalDest(dest: string | undefined): boolean {
    if (!dest) return true;
    return dest === TERMINAL_OUTPUTS_PREFIX || dest.startsWith('outputs.');
}

/**
 * Pick the next step id given the step's edges + the event name the
 * handler emitted. Returns `undefined` when no edge matches (the
 * walker treats this as a terminal step).
 */
export function pickNextStepId(
    step: WorkflowStep,
    event: string,
): string | undefined {
    // Explicit conditional edge wins.
    const onMap = step.on;
    if (onMap && Object.prototype.hasOwnProperty.call(onMap, event)) {
        return onMap[event];
    }
    // Default 'completed' falls through to `next`.
    if (event === 'completed' && step.next !== undefined) {
        return step.next;
    }
    return undefined;
}
