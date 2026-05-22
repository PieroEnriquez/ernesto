/**
 * `ui.table` — emit tabular data. Subscribers truncate large `rows`
 * and surface a "open in thread" / virtualized affordance.
 */

import type { TableProps } from '../../components/types';
import type { UiToolContext } from '../types';

export async function handleTable(
    args: TableProps,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'table', props: args },
    });
    return { ok: true };
}
