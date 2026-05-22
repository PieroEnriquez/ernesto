/**
 * `ui.chart` — emit a chart series. Slack renders via the server-side
 * chart svc (image block); claude.ai / fragua-web render natively;
 * CLI degrades to ASCII via `asciichart`.
 */

import type { ChartProps } from '../../components/types';
import type { UiToolContext } from '../types';

export async function handleChart(
    args: ChartProps,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'chart', props: args },
    });
    return { ok: true };
}
