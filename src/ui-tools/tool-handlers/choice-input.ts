/**
 * `ui.choice_input` — emit a choice prompt AND pause the run via the
 * HitlController. Returns the user's selection (single string when
 * `multi !== true`, string[] when `multi === true`).
 *
 * The slotId is mandatory at emit time so the subscriber can swap the
 * input UI for the resolved value once the user responds. We
 * generate one if the caller didn't supply it.
 */

import { randomUUID } from 'node:crypto';
import type { ChoiceInputProps } from '../../components/types';
import type { UiToolContext } from '../types';

export interface ChoiceInputArgs extends ChoiceInputProps {
    slotId?: string;
}

export async function handleChoiceInput(
    args: ChoiceInputArgs,
    ctx: UiToolContext,
): Promise<string | string[]> {
    const slotId = args.slotId ?? randomUUID();
    const { slotId: _ignored, ...props } = args;
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'choice_input', props, slotId },
    });

    const enumValues = props.choices.map((c) => c.value);
    const schema: Record<string, unknown> = props.multi
        ? {
              type: 'object',
              properties: {
                  choices: {
                      type: 'array',
                      items: { type: 'string', enum: enumValues },
                  },
              },
              required: ['choices'],
          }
        : {
              type: 'object',
              properties: {
                  choice: { type: 'string', enum: enumValues },
              },
              required: ['choice'],
          };

    const response = await ctx.hitl.pauseForHuman({
        runId: ctx.runId,
        stepId: ctx.stepId,
        schema,
        prompt: props.prompt,
    });

    if (props.multi) {
        return (response as { choices: string[] }).choices;
    }
    return (response as { choice: string }).choice;
}
