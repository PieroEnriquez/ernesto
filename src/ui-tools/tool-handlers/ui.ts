/**
 * Unified `ui` tool handler — validates one or more {@link UiComponent}s
 * and emits `fact.component` events.
 *
 * Wire shape: `UiComponent | UiComponent[]` — single component for the
 * ergonomic happy path, array for bulk emit. The handler normalizes to
 * an array, validates each, and emits one `fact.component` per entry.
 *
 * Special case: when an emitted component is `kind: 'hitl'` with an
 * `expect.kind` of `'choice'` or `'form'`, the handler also calls
 * `ctx.hitl.pauseForHuman(...)` and awaits the human's response (the
 * SDK turn stays open until resume). The pause is keyed by the same
 * `runId / stepId` the component was emitted from.
 */

import type { UiComponent } from '../../components/types';
import { coerceUiComponent } from '../../components/coerce';
import {
    collectUiComponentErrors,
    validateUiComponent,
} from '../../components/validation';
import { resolveUiRef } from '../resolve-ui-ref';
import type { UiToolContext } from '../types';

/** Accepted input shapes:
 *   - `UiComponent` / `UiComponent[]` — inline (backwards compat).
 *   - `{ component: <UiComponent | UiComponent[]> }` — inline,
 *     explicit-field shape (mirrors the on-disk file format).
 *   - `{ ref: 'path/to/file.json' }` — workdir-relative ref. The
 *     handler reads the file and treats `component` as the source.
 *     Agent iterates with `Edit` instead of full re-outputs. */
export type UiArgs = UiComponent | UiComponent[] | unknown;

export interface UiCallResult {
    ok: boolean;
    /** Per-component validation errors. One entry per offending
     *  component with EVERY field error found inside it — agents see
     *  the full diagnostic set in one tool-result and can fix
     *  everything in one re-output instead of burning round-trips on
     *  one-field-at-a-time corrections.
     *
     *  When the call used a `ref`, each entry also carries the file
     *  path + JSON path so the agent can `Edit` the offending field
     *  directly without re-reading the whole structure. */
    errors?: {
        index: number;
        errors: string[];
        ref?: string;
        jsonPath?: string;
    }[];
    /** When one of the emitted components was a `hitl` with
     *  `expect.kind` in {`choice`, `form`}, the resolved human response
     *  lands here. */
    response?: unknown;
}

export async function handleUi(
    args: UiArgs,
    ctx: UiToolContext,
): Promise<UiCallResult | unknown> {
    // Resolve the input to a flat `unknown[]` of candidate components.
    // Three accepted shapes; ref-mode reads the file off the workdir.
    let list: unknown[];
    let refPath: string | undefined;
    let jsonPathForIndex: ((i: number) => string) | undefined;
    if (isRefShape(args)) {
        refPath = args.ref;
        if (!ctx.workdirRoot) {
            return {
                ok: false,
                errors: [
                    {
                        index: 0,
                        errors: [
                            'ui ref is not supported in this context (no workdir bound). ' +
                                'Emit the UI inline instead: { component: <UiComponent | UiComponent[]> }.',
                        ],
                        ref: refPath,
                    },
                ],
            };
        }
        const resolved = await resolveUiRef({
            workdirRoot: ctx.workdirRoot,
            ref: refPath,
        });
        if (!resolved.ok) {
            return {
                ok: false,
                errors: [
                    {
                        index: 0,
                        errors: [resolved.message],
                        ref: refPath,
                    },
                ],
            };
        }
        list = resolved.components;
        jsonPathForIndex = resolved.jsonPathForIndex;
    } else if (isComponentFieldShape(args)) {
        const c = (args as { component: unknown }).component;
        list = Array.isArray(c) ? c : [c];
    } else {
        list = Array.isArray(args) ? args : [args];
    }
    const validated: UiComponent[] = [];
    const errors: UiCallResult['errors'] = [];
    for (let i = 0; i < list.length; i++) {
        // Coerce LLM-mangled shapes (JSON-stringified, bare-string props,
        // table columns-as-strings, etc.) before structural validation.
        // Cheaper than a wire round-trip per agent miss.
        const coerced = coerceUiComponent(list[i]);
        const componentErrors = collectUiComponentErrors(coerced);
        if (componentErrors.length > 0) {
            const entry: NonNullable<UiCallResult['errors']>[number] = {
                index: i,
                errors: componentErrors,
            };
            if (refPath) entry.ref = refPath;
            if (jsonPathForIndex) entry.jsonPath = jsonPathForIndex(i);
            errors!.push(entry);
            continue;
        }
        // Cleanly validated — re-run the single-error path to extract
        // the normalized typed value (collect-all does shape checks,
        // doesn't return a typed value).
        const result = validateUiComponent(coerced);
        if (result.ok) {
            validated.push(result.value);
        } else {
            // Defensive — shouldn't happen if collect-all and
            // single-error agree on what's valid.
            const entry: NonNullable<UiCallResult['errors']>[number] = {
                index: i,
                errors: [result.error],
            };
            if (refPath) entry.ref = refPath;
            if (jsonPathForIndex) entry.jsonPath = jsonPathForIndex(i);
            errors!.push(entry);
        }
    }
    if (errors!.length > 0) {
        return { ok: false, errors };
    }

    // Per-tier attachment transformer pass. Lets the host (e.g. the
    // Slack tier) rewrite `attachment` props before emit — most
    // commonly to rasterize SVG → PNG so Slack's file-preview card
    // renders inline. Failures surface here as tool errors so the
    // agent receives them synchronously and can pick a different
    // file format / regenerate without round-tripping through a Slack-
    // side breadcrumb. Hook applies only to top-level attachments;
    // hitl-nested renderables don't carry standalone files.
    if (ctx.transformAttachment) {
        const transformErrors: NonNullable<UiCallResult['errors']> = [];
        for (let i = 0; i < validated.length; i++) {
            const c = validated[i];
            if (c.kind !== 'attachment') continue;
            let result: Awaited<ReturnType<NonNullable<typeof ctx.transformAttachment>>>;
            try {
                result = await ctx.transformAttachment(c);
            } catch (err) {
                // Hooks aren't supposed to throw; defensive catch so a
                // tier bug doesn't crash the agent's turn.
                result = {
                    ok: false,
                    error: `attachment transformer threw: ${(err as Error).message}`,
                };
            }
            if (!result.ok) {
                const entry: NonNullable<UiCallResult['errors']>[number] = {
                    index: i,
                    errors: [result.error],
                };
                if (refPath) entry.ref = refPath;
                if (jsonPathForIndex) entry.jsonPath = jsonPathForIndex(i);
                transformErrors.push(entry);
                continue;
            }
            if (result.component) {
                validated[i] = result.component;
            }
        }
        if (transformErrors.length > 0) {
            return { ok: false, errors: transformErrors };
        }
    }

    // Pause-for-human contract: if any component is a `hitl` expecting
    // structured input, we emit the side-band components first (so the
    // user sees them) and then pause on the hitl. The hitl component
    // ITSELF is emitted before the pause so subscribers see the
    // render payload before the awaiting-input transition lands.
    let pauseComponent: UiComponent | undefined;
    let pauseSchema: Record<string, unknown> | undefined;
    let pauseDefaults: Record<string, unknown> | undefined;
    let pausePrompt: string | undefined;
    let pauseResumePrompt: string | undefined;
    for (const c of validated) {
        if (c.kind === 'hitl') {
            const expect = c.props.expect;
            if (expect.kind === 'choice') {
                pauseComponent = c;
                pauseSchema = {
                    type: 'string',
                    enum: expect.schema.enum,
                };
                if (typeof expect.defaults === 'string') {
                    pauseDefaults = { value: expect.defaults };
                }
                pausePrompt = c.props.resumePrompt;
                pauseResumePrompt = c.props.resumePrompt;
                break;
            }
            if (expect.kind === 'form') {
                pauseComponent = c;
                pauseSchema = expect.schema;
                if (expect.defaults !== undefined) {
                    pauseDefaults = expect.defaults;
                }
                pausePrompt = c.props.resumePrompt;
                pauseResumePrompt = c.props.resumePrompt;
                break;
            }
        }
    }

    for (const component of validated) {
        ctx.emit({ type: 'fact.component', component });
    }

    if (pauseComponent && pauseSchema && pausePrompt) {
        const response = await ctx.hitl.pauseForHuman({
            runId: ctx.runId,
            stepId: ctx.stepId,
            schema: pauseSchema,
            prompt: pausePrompt,
            ...(pauseDefaults !== undefined ? { defaults: pauseDefaults } : {}),
            ...(pauseResumePrompt !== undefined
                ? { resumePrompt: pauseResumePrompt }
                : {}),
        });
        return response;
    }

    return { ok: true };
}

function isRefShape(v: unknown): v is { ref: string } {
    return (
        !!v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        typeof (v as { ref?: unknown }).ref === 'string'
    );
}

function isComponentFieldShape(v: unknown): v is { component: unknown } {
    return (
        !!v &&
        typeof v === 'object' &&
        !Array.isArray(v) &&
        'component' in (v as object) &&
        !('kind' in (v as object))
    );
}
