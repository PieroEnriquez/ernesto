/**
 * `ui.code` — emit syntax-highlightable source. Renderers add the
 * language fence and a copy button where the medium supports it.
 */

import type { CodeProps } from '../../components/types';
import type { UiToolContext } from '../types';

export async function handleCode(
    args: CodeProps,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'code', props: args },
    });
    return { ok: true };
}
