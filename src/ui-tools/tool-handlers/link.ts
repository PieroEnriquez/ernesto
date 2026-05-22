/**
 * `ui.link` — emit a hyperlink. Subscribers render as a button on
 * Slack, OSC-8 anchor on CLI, anchor element on web.
 */

import type { LinkProps } from '../../components/types';
import type { UiToolContext } from '../types';

export async function handleLink(
    args: LinkProps,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'link', props: args },
    });
    return { ok: true };
}
