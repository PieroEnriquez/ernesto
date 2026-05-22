/**
 * `ui.text_input` — emit a free-form text prompt AND pause the run.
 * Returns the user's string (or coerced primitive per the inner schema).
 */

import { randomUUID } from 'node:crypto';
import type { TextInputProps } from '../../components/types';
import type { UiToolContext } from '../types';

export interface TextInputArgs extends TextInputProps {
    slotId?: string;
}

export async function handleTextInput(
    args: TextInputArgs,
    ctx: UiToolContext,
): Promise<unknown> {
    const slotId = args.slotId ?? randomUUID();
    const { slotId: _ignored, ...props } = args;
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'text_input', props, slotId },
    });

    const innerType = props.schema?.type ?? 'string';
    const schema: Record<string, unknown> = {
        type: 'object',
        properties: {
            value: { type: innerType },
        },
        required: ['value'],
    };

    const response = await ctx.hitl.pauseForHuman({
        runId: ctx.runId,
        stepId: ctx.stepId,
        schema,
        prompt: props.prompt,
    });
    return (response as { value: unknown }).value;
}
