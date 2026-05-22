/**
 * `ui.image` — emit an image reference. Subscribers render natively
 * (image block on Slack, `<img>` on claude.ai, URL + alt on CLI).
 */

import type { ImageProps } from '../../components/types';
import type { UiToolContext } from '../types';

export async function handleImage(
    args: ImageProps,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'image', props: args },
    });
    return { ok: true };
}
