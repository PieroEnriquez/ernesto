/**
 * `ui.progress` — emit a progress bar. Update via `slotId` as `current`
 * advances toward `total`; subscribers re-render in place.
 */

import type { ProgressProps } from '../../components/types';
import type { UiToolContext } from '../types';

export interface ProgressInput extends ProgressProps {
    slotId?: string;
}

export async function handleProgress(
    args: ProgressInput,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    const { slotId, ...props } = args;
    ctx.emit({
        type: 'fact.component',
        component: slotId
            ? { kind: 'progress', props, slotId }
            : { kind: 'progress', props },
    });
    return { ok: true };
}
