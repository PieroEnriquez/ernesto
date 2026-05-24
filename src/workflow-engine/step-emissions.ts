/**
 * Step-emission helpers — pure functions that distill a single agent
 * step's stream of `ui` component emissions into the canonical turn
 * state.
 *
 * Layer-3 fallback contract: an agent step is "answered" by its latest
 * `hitl` emission. When the step ends without ANY hitl, the engine
 * synthesizes one from the final assistant text so the uiTrail stays
 * authoritative regardless of the agent's tool discipline.
 */

import type { HitlComponent, UiComponent } from '../components/types';

export interface StepEmissionSummary {
    /** All ui components emitted during a single agent step, in order. */
    components: UiComponent[];
    /** Final assistant text (Layer-3 fallback signal). */
    finalAssistantText?: string;
    /** SDK session UUID captured from the harness. */
    sessionId?: string;
}

/** Find the latest `hitl`-kind component in the emissions, if any. */
export function latestHitl(
    summary: StepEmissionSummary,
): HitlComponent | undefined {
    const components = summary.components;
    for (let i = components.length - 1; i >= 0; i--) {
        const c = components[i];
        if (c && c.kind === 'hitl') return c;
    }
    return undefined;
}

/** Synthesize a default hitl from a plain assistant-text fallback. */
export function synthesizeHitlFromText(text: string): HitlComponent {
    return {
        kind: 'hitl',
        props: {
            render: [{ kind: 'markdown', props: { body: text } }],
            expect: { kind: 'message' },
            resumePrompt: 'User said: {value}.',
        },
    };
}

/**
 * Resolve the canonical hitl for a step. Returns the explicit one if
 * the agent emitted one, else synthesizes from the assistant text,
 * else a "(no response)" placeholder.
 */
export function extractTurnState(summary: StepEmissionSummary): {
    hitl: HitlComponent;
    synthesized: boolean;
} {
    const explicit = latestHitl(summary);
    if (explicit) return { hitl: explicit, synthesized: false };
    const text = summary.finalAssistantText?.trim();
    if (text && text.length > 0) {
        return { hitl: synthesizeHitlFromText(text), synthesized: true };
    }
    return { hitl: synthesizeHitlFromText('(no response)'), synthesized: true };
}
