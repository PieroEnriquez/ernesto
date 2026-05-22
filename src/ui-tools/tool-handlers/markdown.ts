/**
 * `ui.markdown` — free-form markdown. Subscribers pick the dialect
 * (Slack mrkdwn vs GitHub-flavoured vs ANSI).
 */

import type { MarkdownProps } from '../../components/types';
import type { UiToolContext } from '../types';

export async function handleMarkdown(
    args: MarkdownProps,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'markdown', props: args },
    });
    return { ok: true };
}
