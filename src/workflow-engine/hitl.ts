/**
 * HITL pause/resume primitive.
 *
 * When a step handler returns `{ kind: 'paused_human', … }` the runner
 * calls `HitlController.pauseForHuman` which:
 *
 *   1. Emits `fact.run_paused_human` on the event bus.
 *   2. Writes the run state to `paused`.
 *   3. Returns a promise that resolves with the resume value when an
 *      external caller invokes `resume(runId, intent)`.
 *
 * `resume()` validates the intent value against the schema declared
 * at pause time (a minimal hand-rolled JSON-Schema check — we only
 * support strings, enums, objects-of-strings, since that's what the
 * `InputStep` schema shape produces today).
 *
 * The pending pause is keyed by `runId + promptId` so multiple
 * concurrent HITL pauses on the same run (rare, but legal) don't
 * collide.
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from './event-bus';
import type { StorePort } from './store/port';

export interface HitlPauseInput {
    runId: string;
    stepId: string;
    schema: Record<string, unknown>;
    prompt: string;
    routes?: string[];
    defaults?: Record<string, unknown>;
    routing?: Readonly<Record<string, unknown>>;
    /**
     * Agent-authored template for the SDK turn that follows the
     * pause. The renderer materializes it with the human's response
     * (substituting `{value}` and, for object-shaped responses,
     * `{field}` per top-level field) and feeds it back as the
     * next agent turn's user-message content.
     *
     * Stored on the pending pause so the engine has it on `resume()` —
     * even though the current (blocking) HITL model just returns the
     * raw value as the MCP tool's result. The forthcoming non-blocking
     * model ends the agent step on pause and dispatches a new step on
     * resume with `prompt = materializeResumePrompt(template, value)`.
     */
    resumePrompt?: string;
}

export interface ResumeIntent {
    promptId: string;
    value: unknown;
}

interface PendingPause {
    schema: Record<string, unknown>;
    resumePrompt?: string;
    resolve: (value: unknown) => void;
    reject: (err: Error) => void;
}

export class HitlController {
    private readonly pending = new Map<string, PendingPause>();

    constructor(
        private readonly bus: EventBus,
        private readonly store: StorePort,
        private readonly seqAllocator: (runId: string) => number,
    ) {}

    /** Pause the current step pending a resume call. The returned
     *  promise resolves with the resume value (already schema-checked)
     *  or rejects if the run is aborted. */
    pauseForHuman(input: HitlPauseInput): Promise<unknown> {
        const promptId = randomUUID();
        const key = `${input.runId}:${promptId}`;

        // Emit fact.run_paused_human first (subscribers want to know
        // before the promise settles).
        const seq = this.seqAllocator(input.runId);
        const routing = {
            ...(input.routing ?? {}),
            inputSchema: input.schema,
        };
        this.bus.emit({
            runId: input.runId,
            seq,
            type: 'fact.run_paused_human',
            payload: {
                nodeId: input.stepId,
                text: input.prompt,
                routes: input.routes ?? extractRoutesFromSchema(input.schema),
                promptId,
            },
            ts: Date.now(),
            routing,
        });

        // Transition run state to 'paused' if a state exists.
        this.store.getRunState(input.runId).then((state) => {
            if (!state) return;
            if (state.status === 'paused') return;
            this.store.putRunState({ ...state, status: 'paused' });
        });

        return new Promise<unknown>((resolve, reject) => {
            const pending: PendingPause = {
                schema: input.schema,
                resolve,
                reject,
            };
            if (input.resumePrompt !== undefined) {
                pending.resumePrompt = input.resumePrompt;
            }
            this.pending.set(key, pending);
        });
    }

    /**
     * Read the renderer-side framing the agent attached when it paused.
     * The renderer materializes this with the human's response to build
     * the next agent turn's prompt. Returns `undefined` if no template
     * was attached or no pause is pending for `(runId, promptId)`.
     */
    getResumePrompt(runId: string, promptId: string): string | undefined {
        return this.pending.get(`${runId}:${promptId}`)?.resumePrompt;
    }

    /** Resume a paused run. Validates the value, settles the pending
     *  promise, transitions run state back to `running`. */
    async resume(runId: string, intent: ResumeIntent): Promise<void> {
        const key = `${runId}:${intent.promptId}`;
        const pending = this.pending.get(key);
        if (!pending) {
            throw new Error(
                `no pending HITL for run ${runId} prompt ${intent.promptId}`,
            );
        }
        const validationError = validateAgainstSchema(
            intent.value,
            pending.schema,
        );
        if (validationError) {
            throw new Error(`HITL value invalid: ${validationError}`);
        }
        this.pending.delete(key);

        const state = await this.store.getRunState(runId);
        if (state) {
            await this.store.putRunState({ ...state, status: 'running' });
        }
        this.bus.emit({
            runId,
            seq: this.seqAllocator(runId),
            type: 'fact.run_resumed',
            payload: { promptId: intent.promptId },
            ts: Date.now(),
        });
        pending.resolve(intent.value);
    }

    /** Abort all pending HITL pauses for a run (run-level abort path). */
    abortPending(runId: string, reason: string): void {
        for (const [key, pending] of this.pending.entries()) {
            if (!key.startsWith(`${runId}:`)) continue;
            this.pending.delete(key);
            pending.reject(new Error(reason));
        }
    }
}

/**
 * Materialize the agent-authored resume-prompt template with the
 * human's response. Renderers call this when they capture a HITL
 * result; the returned string becomes the next SDK agent turn's
 * user-message content (paired with `resume: <sessionId>`).
 *
 * Substitution:
 *   - `{value}` is replaced with the response (objects + arrays are
 *     JSON-stringified, scalars get their `String(...)` form).
 *   - For an object-shaped response, each top-level `{field}` is
 *     replaced with the field's value (scalars only — nested objects
 *     stringify back via the `{value}` path).
 *
 * Absent template → returns a renderer-default framing
 * (`"The user responded: <value>"`). Renderers MAY override.
 */
export function materializeResumePrompt(
    template: string | undefined,
    value: unknown,
): string {
    const scalar = (v: unknown): string => {
        if (typeof v === 'string') return v;
        if (typeof v === 'number' || typeof v === 'boolean') return String(v);
        try {
            return JSON.stringify(v);
        } catch {
            return String(v);
        }
    };
    if (!template || template.length === 0) {
        return `The user responded: ${scalar(value)}`;
    }
    let out = template.replace(/\{value\}/g, scalar(value));
    if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
    ) {
        for (const [field, fieldValue] of Object.entries(
            value as Record<string, unknown>,
        )) {
            const placeholder = new RegExp(
                `\\{${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`,
                'g',
            );
            out = out.replace(placeholder, scalar(fieldValue));
        }
    }
    return out;
}

/** Best-effort route extraction. Surfaces the enum values a renderer
 *  can render as one-click buttons. Two supported shapes:
 *
 *  - Top-level enum: `{ type: 'string', enum: [...] }`
 *  - Single-property object: `{ type: 'object', properties: { <name>:
 *    { type: 'string', enum: [...] } }, required: [<name>] }`
 *
 *  Anything else returns `['submit']` — the renderer falls back to a
 *  generic form/modal affordance keyed off the full schema. */
function extractRoutesFromSchema(
    schema: Record<string, unknown>,
): string[] {
    // Top-level enum (the natural shape for a single yes/no or pick-one
    // input where the workflow author doesn't want to nest in an object).
    const topEnum = (schema as { enum?: unknown[] }).enum;
    if (Array.isArray(topEnum) && topEnum.length > 0) {
        const out = topEnum.filter((e): e is string => typeof e === 'string');
        if (out.length > 0) return out;
    }
    const props = (schema as { properties?: Record<string, { enum?: unknown[] }> })
        .properties;
    if (!props) return ['submit'];
    const out: string[] = [];
    for (const v of Object.values(props)) {
        if (Array.isArray(v?.enum)) {
            for (const e of v.enum) if (typeof e === 'string') out.push(e);
        }
    }
    return out.length > 0 ? out : ['submit'];
}

/**
 * Minimal JSON-Schema validator. Returns the first error message or
 * `null` if the value is valid.
 *
 * Supported shapes (matches the schemas the `input` step emits):
 *   - `{ type: 'string', enum?: string[] }`
 *   - `{ type: 'number' }`
 *   - `{ type: 'boolean' }`
 *   - `{ type: 'object', properties: { [name]: nested }, required?: string[] }`
 *
 * Anything else is accepted (no constraint emitted). The caller can
 * always reject downstream if the handler needs stricter validation.
 */
export function validateAgainstSchema(
    value: unknown,
    schema: Record<string, unknown>,
): string | null {
    const type = schema.type;
    if (type === 'object') {
        if (
            value === null ||
            typeof value !== 'object' ||
            Array.isArray(value)
        ) {
            return 'expected object';
        }
        const obj = value as Record<string, unknown>;
        const props =
            (schema.properties as Record<string, Record<string, unknown>>) ??
            {};
        const required = (schema.required as string[]) ?? [];
        for (const name of required) {
            if (!Object.prototype.hasOwnProperty.call(obj, name)) {
                return `missing required field: ${name}`;
            }
        }
        for (const [name, sub] of Object.entries(props)) {
            if (!Object.prototype.hasOwnProperty.call(obj, name)) continue;
            const subErr = validateAgainstSchema(obj[name], sub);
            if (subErr) return `${name}: ${subErr}`;
        }
        return null;
    }
    if (type === 'string') {
        if (typeof value !== 'string') return 'expected string';
        const en = schema.enum;
        if (Array.isArray(en) && !en.includes(value)) {
            return `value '${value}' not in enum`;
        }
        return null;
    }
    if (type === 'number') {
        if (typeof value !== 'number') return 'expected number';
        return null;
    }
    if (type === 'boolean') {
        if (typeof value !== 'boolean') return 'expected boolean';
        return null;
    }
    // No declared type — accept everything (caller's choice).
    return null;
}
