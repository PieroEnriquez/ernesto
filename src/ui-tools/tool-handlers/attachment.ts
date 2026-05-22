/**
 * `ui.attachment` — reference to a workspace-attached file. The
 * tier-specific subscriber resolves `ref` against the workspace's
 * attachment provider before rendering.
 */

import type { AttachmentProps } from '../../components/types';
import type { UiToolContext } from '../types';

export async function handleAttachment(
    args: AttachmentProps,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'attachment', props: args },
    });
    return { ok: true };
}
