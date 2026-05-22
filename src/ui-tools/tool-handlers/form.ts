/**
 * `ui.form` — emit a multi-field form AND pause the run. Returns the
 * submitted form data keyed by field id.
 */

import { randomUUID } from 'node:crypto';
import type { FormProps } from '../../components/types';
import type { UiToolContext } from '../types';

export interface FormArgs extends FormProps {
    slotId?: string;
}

export async function handleForm(
    args: FormArgs,
    ctx: UiToolContext,
): Promise<Record<string, unknown>> {
    const slotId = args.slotId ?? randomUUID();
    const { slotId: _ignored, ...props } = args;
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'form', props, slotId },
    });

    // Build a JSON Schema from the form fields. `choice` fields with
    // `options` become string enums; everything else maps to its
    // declared primitive type.
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];
    for (const field of props.fields) {
        const fieldSchema: Record<string, unknown> =
            field.type === 'choice'
                ? {
                      type: 'string',
                      ...(field.options ? { enum: field.options } : {}),
                  }
                : { type: field.type };
        properties[field.id] = fieldSchema;
        if (field.required) required.push(field.id);
    }
    const schema: Record<string, unknown> = {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
    };

    const response = await ctx.hitl.pauseForHuman({
        runId: ctx.runId,
        stepId: ctx.stepId,
        schema,
        prompt: props.prompt,
    });
    return response as Record<string, unknown>;
}
