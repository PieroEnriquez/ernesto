/**
 * Bundled-UI middleware — generic side-channel that lets opt-in MCP
 * tools fold a UI emission into the same tool call as their primary
 * action. Saves SDK round-trips: instead of two calls (`ui([…])` +
 * `execute({…})`), the agent makes one (`execute({…, ui: […]})`).
 *
 * The MCP dispatch wrapper invokes this BEFORE calling the tool
 * handler. Each component in `args.ui` is validated and emitted via
 * `ctx.emit({ type: 'fact.component', component })` — the same path
 * the standalone `ui([…])` tool uses. The handler then runs with `ui`
 * stripped from its args.
 *
 * Partial-success semantics: invalid components are skipped (logged
 * warn) but don't fail the bundle — emission is best-effort so the
 * primary action still runs.
 *
 * HITL pause contract: if a bundled `hitl` component has
 * `expect.kind ∈ {'choice', 'form'}`, the middleware calls
 * `ctx.hitl.pauseForHuman(...)` mirroring `handleUi`. When the dispatch
 * has no `ctx.hitl` (e.g. tools running outside an HITL-capable scope),
 * the hitl component is still emitted but the pause is skipped + warned.
 */

import { z } from 'zod';
import type { UiComponent } from '../components/types';
import { UI_COMPONENT_KINDS } from '../components/types';
import { coerceUiComponent } from '../components/coerce';
import { validateUiComponent } from '../components/validation';
import type { UiHitlPauser } from './types';

/** Minimal context needed by the middleware — a subset of
 *  `UiToolContext`. Tools that don't have HITL wired pass `hitl:
 *  undefined`. */
export interface BundledUiContext {
    emit: (event: { type: 'fact.component'; component: UiComponent }) => void;
    log: { warn: (msg: string, meta?: unknown) => void };
    /** Optional — when present, bundled `hitl` components with
     *  structured `expect` pause the dispatch via this pauser. */
    hitl?: UiHitlPauser;
    /** Routing for the HITL pause (matches the standalone `ui` tool).
     *  Required iff `hitl` is set. */
    runId?: string;
    stepId?: string;
}

export interface BundledUiResult {
    /** Args with the `ui` field stripped (regardless of validity). */
    cleanedArgs: Record<string, unknown>;
    /** Count of components that validated + were emitted. */
    emittedCount: number;
    /** Count of invalid components that were skipped (log warn). */
    skippedCount: number;
    /** When a bundled `hitl` triggered a pause and the dispatch context
     *  carried `ctx.hitl`, the resolved human response lands here. The
     *  dispatch wrapper surfaces this back to the agent. */
    hitlResponse?: unknown;
}

/**
 * Zod schema for the `ui: UiComponent[]` field tools opt into. Kept
 * permissive on shape (structural validation lives in
 * {@link validateUiComponent}) — mirrors the wire schema of the
 * standalone `ui` tool.
 *
 * **Required, not optional.** Agents must explicitly pass `ui: []`
 * when they don't want to bundle anything. The forcing function
 * primes the agent to consider the bundle on every call (status
 * pills alongside `execute`, thinking notes, etc.) — making the
 * common-case bundling pattern feel native rather than a forgotten
 * optimisation.
 */
export const bundledUiComponentSchema = z.object({
    kind: z.enum(UI_COMPONENT_KINDS),
    props: z.record(z.string(), z.unknown()),
    slotId: z.string().optional(),
});

export const bundledUiFieldSchema = z.array(bundledUiComponentSchema).default([]);

/**
 * Helper: attach the required `ui: UiComponent[]` field to any Zod
 * raw shape. Used by tools that opt into bundling so their declared
 * input schema reflects the side-channel field on the wire.
 */
export function withBundledUiField<S extends z.ZodRawShape>(
    schema: S,
): S & { ui: typeof bundledUiFieldSchema } {
    return { ...schema, ui: bundledUiFieldSchema };
}

/**
 * Pre-process bundled `ui` from tool args. Pure side-effect on emit +
 * log + hitl.pauseForHuman. Returns the args with `ui` stripped so the
 * downstream handler sees only its own input shape.
 */
export async function extractAndEmitBundledUi(
    args: Record<string, unknown>,
    ctx: BundledUiContext,
): Promise<BundledUiResult> {
    const rawUi = args.ui;
    if (!Array.isArray(rawUi) || rawUi.length === 0) {
        // Strip a present-but-empty `ui` field defensively so the
        // handler never sees it.
        const { ui: _ui, ...rest } = args;
        return {
            cleanedArgs: rawUi === undefined ? args : (rest as Record<string, unknown>),
            emittedCount: 0,
            skippedCount: 0,
        };
    }

    const validated: UiComponent[] = [];
    let skippedCount = 0;
    for (let i = 0; i < rawUi.length; i++) {
        // Coerce LLM-mangled shapes before structural validation; the
        // bundled-ui side-channel sees the same agent quirks as the
        // standalone `ui` tool.
        const coerced = coerceUiComponent(rawUi[i]);
        const result = validateUiComponent(coerced);
        if (!result.ok) {
            skippedCount += 1;
            ctx.log.warn('bundled-ui: skipping invalid component', {
                index: i,
                error: result.error,
            });
            continue;
        }
        validated.push(result.value);
    }

    // Find the first hitl with structured expect — mirrors handleUi.
    let pauseExpectKind: 'choice' | 'form' | undefined;
    let pauseSchema: Record<string, unknown> | undefined;
    let pauseDefaults: Record<string, unknown> | undefined;
    let pausePrompt: string | undefined;
    for (const c of validated) {
        if (c.kind === 'hitl') {
            const expect = c.props.expect;
            if (expect.kind === 'choice') {
                pauseExpectKind = 'choice';
                pauseSchema = { type: 'string', enum: expect.schema.enum };
                if (typeof expect.defaults === 'string') {
                    pauseDefaults = { value: expect.defaults };
                }
                pausePrompt = c.props.resumePrompt;
                break;
            }
            if (expect.kind === 'form') {
                pauseExpectKind = 'form';
                pauseSchema = expect.schema;
                if (expect.defaults !== undefined) {
                    pauseDefaults = expect.defaults;
                }
                pausePrompt = c.props.resumePrompt;
                break;
            }
        }
    }

    // Emit BEFORE pause so subscribers see the render payload before the
    // awaiting-input transition lands.
    for (const component of validated) {
        ctx.emit({ type: 'fact.component', component });
    }

    let hitlResponse: unknown;
    if (pauseExpectKind && pauseSchema && pausePrompt) {
        if (ctx.hitl && ctx.runId && ctx.stepId) {
            hitlResponse = await ctx.hitl.pauseForHuman({
                runId: ctx.runId,
                stepId: ctx.stepId,
                schema: pauseSchema,
                prompt: pausePrompt,
                ...(pauseDefaults !== undefined ? { defaults: pauseDefaults } : {}),
                resumePrompt: pausePrompt,
            });
        } else {
            // No HITL surface for this dispatch — the component is still
            // emitted (best-effort visibility) but we can't pause.
            ctx.log.warn(
                'bundled-ui: hitl component with structured expect bundled, but no hitl context available — skipping pause',
                { expectKind: pauseExpectKind },
            );
        }
    }

    const { ui: _ui, ...cleanedArgs } = args;
    return {
        cleanedArgs: cleanedArgs as Record<string, unknown>,
        emittedCount: validated.length,
        skippedCount,
        ...(hitlResponse !== undefined ? { hitlResponse } : {}),
    };
}
