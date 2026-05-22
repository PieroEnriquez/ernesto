/**
 * `ui.input` — emit an input prompt AND pause the run via the
 * HitlController. Returns the user's response, typed per the supplied
 * `schema`.
 *
 * This is the sole HITL primitive — the prior `choice_input` /
 * `text_input` / `form` variants collapsed into one component
 * discriminated by the JSON Schema shape (see
 * `agent-ops://workflows-unification/components.md` §
 * *Why one `input` and not three*).
 *
 * The slotId is mandatory at emit time so the subscriber can swap the
 * input UI for the resolved value once the user responds. We generate
 * one if the caller didn't supply it.
 */

import { randomUUID } from 'node:crypto';
import type { InputProps } from '../../components/types';
import type { UiToolContext } from '../types';

export interface InputArgs extends InputProps {
    slotId?: string;
}

export async function handleInput(
    args: InputArgs,
    ctx: UiToolContext,
): Promise<unknown> {
    const slotId = args.slotId ?? randomUUID();
    const { slotId: _ignored, ...props } = args;
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'input', props, slotId },
    });

    const defaults =
        props.defaults &&
        typeof props.defaults === 'object' &&
        !Array.isArray(props.defaults)
            ? (props.defaults as Record<string, unknown>)
            : undefined;
    const response = await ctx.hitl.pauseForHuman({
        runId: ctx.runId,
        stepId: ctx.stepId,
        schema: props.schema,
        prompt: props.prompt,
        ...(defaults !== undefined ? { defaults } : {}),
    });
    return response;
}
