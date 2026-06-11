/**
 * `convene` step kind handler — the workflow capability that posts a
 * typed ASK into a room and parks the run until a member resolves it
 * (or it expires).
 *
 * Modeled on the `monitor` step (paused_signal + durable park + an
 * external worker/route resuming via `runner.resumeRun`), NOT on the
 * legacy in-heap `HitlController` (blocking, restart-fragile) and NOT
 * on `paused_human` (whose `fact.run_paused_human` emit is wire-coupled
 * to the legacy Slack/app HITL renderers — the room timeline is the
 * single ask surface, so a second render channel would double-post).
 *
 * Division of labour:
 *
 *   - The ENGINE (this handler) resolves the target room reference,
 *     computes the ask payload from step YAML, calls the injected
 *     `ConvenePort` to create the ask, and parks durably with the
 *     minted `askToken` as the pause's `signalKey`. It knows nothing
 *     about Mongo, room membership, timelines, or timers.
 *   - The BACKEND adapter (behind `ConvenePort`) creates-or-dedupes
 *     the durable ask row, posts the brief as a system message plus
 *     the `room.ask` frame, schedules nudge/expire timers, and — when
 *     the rooms-side resolve (or the expire timer) fires — calls
 *     `runner.resumeRun({ runId, promptId, value })` with the typed
 *     result envelope. The promptId is recovered from the run's
 *     `resume.paused` by `signalKey === askToken` (monitor-store
 *     precedent).
 *
 * Solo HITL is the one-member degenerate case: `room: inbox:<user>`
 * targets the user's inbox room through the exact same path — zero
 * special-cased code.
 *
 * Backend boot wires it via:
 *
 *   runner.registerStepKind('convene', makeConveneStepHandler({
 *       port: conveneRoomsAdapter,
 *       log,
 *   }));
 */

import { randomUUID } from 'node:crypto';
import type { ConveneStep } from '../../workflows/types';
import type { StepKindHandler, EngineLogger } from '../types/handler';

/** Caller-fault tags the port may throw (`Error('<tag>: <detail>')`).
 *  Preserved verbatim into the step error so the run error reaches the
 *  backend wire classifier intact (same protocol as route handlers —
 *  see `handlers/route-step.ts`). Untagged throws are server faults:
 *  their raw text must not ride `run.error.message`. */
const CALLER_FAULT_TAG_RE = /^(scope_denied|invalid_input|not_found): /;

/** Default resolution-value schema — a one-field approve/decline
 *  decision object (the cross-agent ask-frame default). */
export const DEFAULT_CONVENE_VALUE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: { decision: { enum: ['approve', 'decline'] } },
    required: ['decision'],
};

/** Envelope schema the run parks with. `resumeDurable` validates the
 *  WHOLE resume value against the parked schema, so the park schema is
 *  the result ENVELOPE — the ask's own value-schema is enforced where
 *  it belongs, at the rooms resolve gate (which sees the raw submitted
 *  value before wrapping it in this envelope). */
export const CONVENE_RESUME_ENVELOPE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: { outcome: { type: 'string', enum: ['resolved', 'timeout'] } },
    required: ['outcome'],
};

/** Parsed target of a convene step's `room:` reference. */
export type ConveneRoomTarget =
    | { kind: 'room'; roomId: string }
    | {
          /** Solo case — the target user's inbox room. `user` is the
           *  raw `<user-ref>` from `inbox:<user-ref>`; the adapter owns
           *  resolving it (user id, email, …) to the inbox room. */
          kind: 'inbox';
          user: string;
      };

/** Ask dedupe provenance. The adapter keys create-or-refresh on
 *  `(workflow, subject)`: an open (pending) ask with the same key is
 *  refreshed instead of a new one being created, so re-dispatches
 *  don't stack pings. `workflow` is left for the adapter to fill from
 *  the durable run row (the engine hands it `runId`); `subject` comes
 *  from step YAML. */
export interface ConveneProvenance {
    workflow?: string;
    subject?: string;
}

/** Everything the backend adapter needs to create (or dedupe-refresh)
 *  the ask and arm its timers. One request per park. */
export interface ConveneAskRequest {
    /** Engine-minted pause token (`ask:<uuid>`); also the parked
     *  pause's `signalKey`. The adapter stores it on the ask row and
     *  recovers the promptId from the run's `resume.paused` by
     *  `signalKey === askToken` when resolution/expiry resumes the
     *  run. On a dedupe-refresh the existing pending ask re-binds to
     *  THIS token (the prior parked run, if any, was already resolved
     *  or superseded). */
    askToken: string;
    runId: string;
    /** Full node id of the convene step (path-prefixed). */
    stepId: string;
    room: ConveneRoomTarget;
    /** Plain-language ask headline (voice rule: no internal vocabulary
     *  on room surfaces). */
    title: string;
    /** Plain-language ask body — posted as a system message + carried
     *  on the `room.ask` frame. */
    brief: string;
    /** JSON Schema for the resolution value — enforced at the rooms
     *  resolve gate, not at engine resume. */
    schema: Record<string, unknown>;
    /** Who may resolve: every room member, or an explicit user list. */
    resolvers: 'any-member' | string[];
    provenance: ConveneProvenance;
    /**
     * KEYSTONE — the workflow's OWN execution scopes: the dispatching
     * principal's effective scope set (post-§7.4 narrowing), exactly
     * as the step handler observed it. Service principals contribute
     * an empty list (their authority model is the allowlist, not
     * scope membership).
     *
     * CONTRACT: the adapter MUST refuse a target room whose
     * `declaredScopes` exceed these — throw a tagged caller-fault
     * `Error('scope_denied: …; missing: a, b')`. A convene must never
     * widen authority: parking an ask in a room the workflow itself
     * couldn't operate in would leak the ask's subject across a
     * privilege boundary and let the resolution flow back in.
     */
    executionScopes: ReadonlyArray<string>;
    /** Re-post a `room.ask` refresh frame after this many seconds
     *  pending (adapter-owned timer). */
    nudgeAfterSec?: number;
    /** CAS the ask pending→expired and resume the run with
     *  `{ outcome: 'timeout' }` after this many seconds pending
     *  (adapter-owned timer). */
    expireAfterSec?: number;
}

/** What the adapter returns once the ask exists (created or
 *  dedupe-refreshed). Informational — the engine parks either way. */
export interface ConveneAskReceipt {
    askId: string;
    /** True when an open ask with the same `(workflow, subject)` was
     *  refreshed instead of a new one created. */
    deduped: boolean;
    /** Room draft version the ask was bound to at render, when the
     *  adapter knows it at create time. */
    boundVersion?: string;
}

/**
 * Narrow port the backend implements. The engine knows rooms only
 * through this interface — no Mongo models, no timeline frames, no
 * BullMQ. See `ConveneAskRequest.executionScopes` for the scope-gate
 * contract the implementation MUST honor.
 *
 * Throw contract: caller-fault failures use tagged errors
 * (`'scope_denied: …'`, `'invalid_input: …'`, `'not_found: …'`) which
 * the handler preserves verbatim into the step error; anything else is
 * treated as a server fault and flattened.
 */
export interface ConvenePort {
    createAsk(request: ConveneAskRequest): Promise<ConveneAskReceipt>;
}

/**
 * Typed step result a convene step yields once the run resumes — the
 * resume value IS the step output (the engine seeds it; the handler is
 * NOT re-run), so this is also the envelope the backend passes to
 * `runner.resumeRun`. Available to later steps via
 * `${{ steps.<id>.outputs.X }}`.
 *
 * A withdrawn ask resumes through the same rail — the backend picks
 * the envelope (graceful continuation) or calls `runner.abortRun` to
 * kill the run outright.
 */
export interface ConveneStepResult {
    outcome: 'resolved' | 'timeout';
    /** The schema-typed resolution value (resolved only). */
    value?: unknown;
    resolverUserId?: string;
    /** Room draft version the ask was bound to when resolved. */
    boundVersion?: string;
    /** What changed in the room digest between ask and resolution. */
    digestDelta?: unknown;
}

export interface ConveneStepHandlerDeps {
    port: ConvenePort;
    log: EngineLogger;
}

/** Parse the step's `room:` reference. Exported for the backend
 *  adapter's own input handling (one parser, no drift). */
export function parseConveneRoomTarget(room: unknown): ConveneRoomTarget | { error: string } {
    if (typeof room !== 'string' || room.trim() === '') {
        return { error: 'invalid_input: convene step needs a target room (a room id, or inbox:<user>)' };
    }
    const trimmed = room.trim();
    if (trimmed.startsWith('inbox:')) {
        const user = trimmed.slice('inbox:'.length).trim();
        if (user === '') {
            return { error: 'invalid_input: inbox target needs a user (inbox:<user>)' };
        }
        return { kind: 'inbox', user };
    }
    return { kind: 'room', roomId: trimmed };
}

export function makeConveneStepHandler(deps: ConveneStepHandlerDeps): StepKindHandler<ConveneStep> {
    return async (step, ctx) => {
        const target = parseConveneRoomTarget(step.room);
        if ('error' in target) {
            return { kind: 'error', code: 'invalid_input', message: target.error };
        }
        if (typeof step.title !== 'string' || step.title.trim() === '') {
            return { kind: 'error', code: 'invalid_input', message: 'invalid_input: convene step needs a title' };
        }
        if (typeof step.brief !== 'string' || step.brief.trim() === '') {
            return { kind: 'error', code: 'invalid_input', message: 'invalid_input: convene step needs a brief' };
        }

        const askToken = `ask:${randomUUID()}`;
        // The workflow's own execution scopes — what the dispatching
        // principal effectively runs with. The port contract requires
        // the adapter to refuse rooms whose declaredScopes exceed them.
        const executionScopes = ctx.principal.kind === 'user' ? [...ctx.principal.scopes] : [];

        const request: ConveneAskRequest = {
            askToken,
            runId: ctx.runId,
            stepId: ctx.stepId,
            room: target,
            title: step.title,
            brief: step.brief,
            schema: step.schema ?? DEFAULT_CONVENE_VALUE_SCHEMA,
            resolvers: step.resolvers ?? 'any-member',
            // `workflow` stays adapter-filled (from the durable run row
            // via `runId`) — the handler context doesn't carry the slug.
            provenance: { ...(step.subject !== undefined ? { subject: step.subject } : {}) },
            executionScopes,
            ...(step.nudgeAfterSec !== undefined ? { nudgeAfterSec: step.nudgeAfterSec } : {}),
            ...(step.expireAfterSec !== undefined ? { expireAfterSec: step.expireAfterSec } : {}),
        };

        let receipt: ConveneAskReceipt;
        try {
            receipt = await deps.port.createAsk(request);
        } catch (err) {
            const message = (err as Error).message ?? 'convene port failed';
            if (CALLER_FAULT_TAG_RE.test(message)) {
                // Tagged caller fault (scope_denied / invalid_input /
                // not_found) — preserve verbatim so the wire classifier
                // can project it (403 {code, missing[]} / 400 / 404).
                return {
                    kind: 'error',
                    code: message.slice(0, message.indexOf(':')),
                    message,
                };
            }
            deps.log.error('convene port createAsk failed', {
                runId: ctx.runId,
                stepId: ctx.stepId,
                errorMessage: message,
            });
            return {
                kind: 'error',
                code: 'convene_failed',
                message: 'convene step failed to create the ask',
                details: { message },
            };
        }

        deps.log.info('convene ask parked', {
            runId: ctx.runId,
            stepId: ctx.stepId,
            askToken,
            askId: receipt.askId,
            deduped: receipt.deduped,
        });

        // Park durably on the existing signal rail: the askToken is the
        // signalKey; resolution/expiry resumes via `runner.resumeRun`
        // with a `ConveneStepResult` envelope, validated against the
        // envelope schema by `resumeDurable`.
        return {
            kind: 'paused_signal',
            signalKey: askToken,
            schema: CONVENE_RESUME_ENVELOPE_SCHEMA,
        };
    };
}
