/**
 * `ui.metric` — emit a single KPI / metric tile with optional delta.
 */

import type { MetricProps } from '../../components/types';
import type { UiToolContext } from '../types';

export async function handleMetric(
    args: MetricProps,
    ctx: UiToolContext,
): Promise<{ ok: true }> {
    ctx.emit({
        type: 'fact.component',
        component: { kind: 'metric', props: args },
    });
    return { ok: true };
}
