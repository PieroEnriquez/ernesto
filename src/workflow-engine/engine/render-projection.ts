/**
 * Render-manifest universalization for step outputs.
 *
 * Any step handler whose `completed` result carries a sibling
 * `render: RenderEntry[]` field has the manifest walked against the
 * remaining output and its components emitted as `fact.component`
 * events — the same channel `route/dispatch.ts` uses via
 * `applyRenderManifest`. The `render` key is stripped from the
 * recorded output so downstream `{ from: stepId }` references see
 * only the data.
 *
 * Turns "emit UI" from a step-kind feature (route handlers only)
 * into a return-shape convention available to every kind — agent,
 * subworkflow, parallel. Route steps are unaffected: their handler
 * returns the stripped envelope `dispatchRoute` already produced
 * (no sibling `render`), so this projector no-ops on them.
 *
 * Failure modes log + fall through to "treat output as plain data"
 * so a malformed `render` field never blocks the run.
 */

import type { UiComponent } from '../../components/types';
import { applyRenderManifest, type RenderEntry } from '../../route/render';
import type { EmitFactEvent, EngineLogger } from '../types/handler';

export function projectStepOutput(output: unknown, stepEmit: EmitFactEvent, log: EngineLogger, stepId: string): unknown {
    if (!output || typeof output !== 'object' || Array.isArray(output)) {
        return output;
    }
    const obj = output as Record<string, unknown>;
    const manifest = obj.render;
    if (!Array.isArray(manifest) || manifest.length === 0) return output;
    const { render: _render, ...rest } = obj;
    let components;
    try {
        components = applyRenderManifest(rest, manifest as RenderEntry[]);
    } catch (err) {
        log.warn('render manifest walk failed', {
            stepId,
            errorMessage: (err as Error).message,
        });
        return rest;
    }
    for (const c of components) {
        try {
            // The manifest produces both top-level UiComponent kinds and
            // renderable kinds; the fact.component channel carries the
            // top-level union at the type level but accepts both in
            // practice — Wave-2 collapses these to a single shape.
            stepEmit({
                type: 'fact.component',
                component: c as unknown as UiComponent,
            });
        } catch (emitErr) {
            log.warn('render manifest emit failed', {
                stepId,
                kind: c.kind,
                errorMessage: (emitErr as Error).message,
            });
        }
    }
    return rest;
}
