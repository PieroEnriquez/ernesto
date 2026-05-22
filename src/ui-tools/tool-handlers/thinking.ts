/**
 * `ui.thinking` — emit an agent's reasoning. Subscribers MAY surface
 * collapsed by default (claude.ai's "inner thoughts" pattern, Slack's
 * collapsible block, CLI's `chalk.gray`).
 */

import type { ThinkingProps } from '../../components/types';
import type { UiToolContext } from '../types';

export interface ThinkingInput extends ThinkingProps {
    slotId?: string;
}

export async function handleThinking(
    args: ThinkingInput,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    const { slotId, ...props } = args;
    ctx.emit({
        type: 'fact.component',
        component: slotId
            ? { kind: 'thinking', props, slotId }
            : { kind: 'thinking', props },
    });
    return { ok: true };
}
