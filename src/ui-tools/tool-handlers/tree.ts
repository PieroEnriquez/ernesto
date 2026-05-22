/**
 * `ui.tree` — emit a nested-structure tree. Subscribers render as a
 * nested markdown list / archy on CLI / native tree widget on web.
 */

import type { TreeProps } from '../../components/types';
import type { UiToolContext } from '../types';

export async function handleTree(
    args: TreeProps,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'tree', props: args },
    });
    return { ok: true };
}
