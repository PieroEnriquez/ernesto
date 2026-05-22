/**
 * `ui.status` — emit a status pill. Update via `slotId` to walk
 * through stages (`status:fetching → status:summarizing → status:done`)
 * without spawning a new pill per stage.
 */

import type { StatusProps } from '../../components/types';
import type { UiToolContext } from '../types';

export interface StatusInput extends StatusProps {
    slotId?: string;
}

export async function handleStatus(
    args: StatusInput,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    const { slotId, ...props } = args;
    ctx.emit({
        type: 'fact.component',
        component: slotId
            ? { kind: 'status', props, slotId }
            : { kind: 'status', props },
    });
    return { ok: true };
}
