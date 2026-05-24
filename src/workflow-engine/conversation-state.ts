/**
 * Conversation state — durable, renderer-agnostic record of "what is
 * happening for this conversation right now".
 *
 * Storage: `<workdir>/.ernesto/state.json`. The workdir is the per-
 * conversation anchor (resolved by the renderer's `conversationKey` —
 * `slack:<threadTs>`, `tier-b:<convId>`, `tier-c:<pid>`, …). One state
 * file per workdir; one workdir per conversation.
 *
 * **Why on disk (not Mongo, not in-memory)**
 *
 *   - Renderers read it from any process / replica — no shared cache.
 *   - Survives backend restarts: pending HITL doesn't vanish when the
 *     node crashes.
 *   - Lives next to `.ernesto/session-id` (SDK session UUID) and the
 *     SDK's `.claude/` session JSONL — one filesystem, one ground
 *     truth per conversation. Master-fs already owns the workdir tree.
 *
 * **Renderer contract**
 *
 * On every input event from its surface (new message, button click,
 * etc.) the renderer:
 *
 *   1. Resolves the workdir for its conversation key.
 *   2. `loadConversationState(workdir)` to see the current status.
 *   3. Dispatches state-appropriately (see `decideRendererAction`):
 *      - `new` / `completed` / `errored` / `canceled`: dispatch a
 *        fresh agent turn with the user's input as the prompt.
 *      - `awaiting_input`: either resume the HITL with the input
 *        treated as the response (if the renderer can map it to the
 *        pending schema) or supersede the HITL by dispatching a fresh
 *        turn with the input as a new prompt.
 *      - `running`: abort the active run (so the SDK call stops
 *        cleanly), then dispatch a fresh turn.
 *
 * The engine + step handler write this file at lifecycle moments
 * (`writeStatus`, `writePendingHitl`, `clearPendingHitl`, `writeError`).
 * Renderers only read it (and act on what they see).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type {
    HitlComponent,
    HitlExpect,
    RenderableComponent,
} from '../components/types';

/** Schema version — bump on breaking changes. Older files load with a
 *  best-effort cast; newer files surface a warning to the renderer. */
export const CONVERSATION_STATE_VERSION = 1;

export type ConversationStatus =
    | 'new'
    | 'running'
    | 'awaiting_input'
    | 'completed'
    | 'errored'
    | 'canceled';

export interface PendingHitlRecord {
    /** Workflow run that emitted the pause. Useful for aborting the
     *  in-flight run when the renderer decides to supersede the HITL. */
    runId: string;
    /** Pause-scoped id the engine assigned. The renderer echoes it on
     *  `resumeRun` so the engine can match the right pending pause. */
    promptId: string;
    /** What the agent expects in the next turn — drives renderer
     *  widget selection (`choice` → button row, `form` → modal, etc.). */
    expect: HitlExpect;
    /** Agent-authored template for the resumed turn (see
     *  `materializeResumePrompt`). When the renderer captures the
     *  response, it substitutes `{value}` / `{field}` and feeds the
     *  result back as the next agent turn's prompt. */
    resumePrompt: string;
    /** The visible answer body the agent rendered at pause time. */
    render: RenderableComponent[];
}

export interface ConversationState {
    version: typeof CONVERSATION_STATE_VERSION;
    status: ConversationStatus;
    /** Run id of the currently-active agent run, if any. Set when the
     *  status is `running` or `awaiting_input`; cleared on terminal. */
    activeRunId?: string;
    /** SDK session UUID for this conversation — captured from
     *  `RunResult.sessionId` and reused as `resumeSessionId` on the
     *  next agent turn. One source of truth: the same atomic file
     *  write that carries `status` also carries the resumable session
     *  pointer, so the two can't disagree. */
    sessionId?: string;
    /** Wall-clock ms of the last transition. Renderers may use it for
     *  staleness checks (e.g. "this run has been running >5 min, prompt
     *  the user about it"). */
    lastTransitionAt: number;
    /** Set when `status === 'awaiting_input'`. Cleared on resume,
     *  supersession, or terminal. */
    pendingHitl?: PendingHitlRecord;
    /** Set when `status === 'errored'`. */
    lastError?: { code: string; message: string };
    /**
     * Authoritative trail of components the agent rendered across this
     * conversation. Renderer prompt strategies prepend a
     * `<previous_turn_rendered>` block built from this trail so the
     * model reads its own past renders as truth — bypassing the SDK
     * `interrupted_turn` / `(resume)` noise on session resumption.
     *
     * Rolling cap of 50 entries (oldest dropped). The SDK conversation
     * tree is a cache of past tool-use; this is ground truth.
     */
    uiTrail?: UiTrailEntry[];
}

/**
 * One hitl emission the agent produced during a turn. Appended via
 * {@link appendHitlToTrail} from the engine-side wire path.
 *
 * Side-band kinds (`thinking`/`status`/`progress`/`attachment`) flow to
 * the renderer but are NOT recorded here — uiTrail is the authoritative
 * sequence of canonical per-turn answers.
 */
export interface UiTrailEntry {
    /** Wall-clock ms when the hitl was emitted. */
    ts: number;
    /** Run that emitted this hitl. */
    runId: string;
    /** Full hitl payload — render + expect + resumePrompt + nextSteps. */
    hitl: HitlComponent;
}

/** Maximum entries retained in `uiTrail` (rolling cap). */
export const UI_TRAIL_CAP = 50;

const STATE_DIR_NAME = '.ernesto';
const STATE_FILE_NAME = 'state.json';

function stateFilePath(workdir: string): string {
    return path.join(workdir, STATE_DIR_NAME, STATE_FILE_NAME);
}

/**
 * Load the conversation state for a workdir.
 *
 * Returns `undefined` when the file is absent (new conversation) or
 * malformed (treat as new — the next save will overwrite cleanly).
 */
export async function loadConversationState(
    workdir: string,
): Promise<ConversationState | undefined> {
    const filePath = stateFilePath(workdir);
    let text: string;
    try {
        text = await fs.readFile(filePath, 'utf8');
    } catch {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.status !== 'string') return undefined;
    // Best-effort cast — accept future versions, surface a console
    // warning if the renderer's lib is older than the writer's.
    return obj as unknown as ConversationState;
}

/**
 * Atomically save the conversation state. Writes to a sibling temp
 * file + rename so a crash mid-write can't leave a half-written
 * state.json that bricks the next load.
 */
export async function saveConversationState(
    workdir: string,
    state: ConversationState,
): Promise<void> {
    const filePath = stateFilePath(workdir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmpPath, filePath);
}

/**
 * Convenience updater. Loads (or fabricates a `new`-status baseline),
 * applies `mutate`, saves. Single-process safe — concurrent saves on
 * the same workdir from different processes could race (last-write-
 * wins). The renderer is the only writer on the hot path, so this is
 * fine in practice; if you ever need locking, the workdir's existing
 * Redis lock from `openWorkdir` is the right primitive.
 */
export async function updateConversationState(
    workdir: string,
    mutate: (prev: ConversationState) => ConversationState,
): Promise<ConversationState> {
    const prev =
        (await loadConversationState(workdir)) ?? {
            version: CONVERSATION_STATE_VERSION,
            status: 'new' as const,
            lastTransitionAt: 0,
        };
    const next = mutate(prev);
    next.lastTransitionAt = Date.now();
    await saveConversationState(workdir, next);
    return next;
}

/**
 * Atomically append one hitl entry to `uiTrail`, applying the rolling
 * {@link UI_TRAIL_CAP} so the oldest entries drop when full. Uses
 * `updateConversationState` so the append is load-mutate-rename
 * (single-process atomic, last-write-wins across processes).
 */
export async function appendHitlToTrail(
    workdir: string,
    runId: string,
    hitl: HitlComponent,
): Promise<void> {
    const entry: UiTrailEntry = { ts: Date.now(), runId, hitl };
    await updateConversationState(workdir, (prev) => {
        const trail = prev.uiTrail ? [...prev.uiTrail, entry] : [entry];
        const capped =
            trail.length > UI_TRAIL_CAP
                ? trail.slice(trail.length - UI_TRAIL_CAP)
                : trail;
        return { ...prev, uiTrail: capped };
    });
}

/**
 * @deprecated Migration shim — call {@link appendHitlToTrail} directly.
 * Routes hitl entries through; no-ops for non-hitl components since
 * side-band kinds (thinking/status/progress/attachment) are no longer
 * part of the uiTrail contract.
 */
export async function appendUiTrail(
    workdir: string,
    entry: { ts?: number; runId: string; component: unknown } | UiTrailEntry,
): Promise<void> {
    // New-shape entry passed straight in.
    if ('hitl' in entry && entry.hitl) {
        await appendHitlToTrail(workdir, entry.runId, entry.hitl);
        return;
    }
    const comp = (entry as { component?: unknown }).component;
    if (
        comp &&
        typeof comp === 'object' &&
        (comp as { kind?: unknown }).kind === 'hitl'
    ) {
        await appendHitlToTrail(workdir, entry.runId, comp as HitlComponent);
    }
    // Non-hitl component — no-op (side-band kinds aren't trail material).
}

/**
 * Renderer-input — the typed payload a renderer collects from its
 * surface (Slack message, button click, MCP elicit response, CLI
 * input). Shape varies per kind; `metadata` is renderer-namespaced
 * extra context (Slack: channel id, requester email, attachments;
 * Tier-B: conversationId, etc.) the strategy hooks may consume.
 */
export type RendererInput =
    | {
          kind: 'new_message';
          /** Raw user text for this turn. The strategy decides how (and
           *  whether) to wrap it. */
          text: string;
          metadata?: Record<string, unknown>;
      }
    | {
          kind: 'hitl_response';
          /** Pause id the agent emitted via `ui.input`. Must match
           *  `state.pendingHitl.promptId` for the response to be
           *  recognized; otherwise treated as a stale interaction and
           *  routed through `forAwaitingInputPreempted`. */
          promptId: string;
          /** Schema-validated response shape (string for enum buttons,
           *  object for forms, etc.). */
          value: unknown;
          metadata?: Record<string, unknown>;
      };

/**
 * Per-state prompt hooks the renderer plugs in. Each hook receives the
 * current `RendererInput` plus per-state extras (pending HITL record,
 * last error). All hooks are optional — anything missing falls back
 * to `defaultRendererStrategy`.
 *
 * **Precedence** (high → low): agent-authored `resumePrompt` on the
 * HITL component (consumed by `forAwaitingInputResolved` via
 * `materializeResumePrompt`) > renderer-provided hook > lib default.
 */
/** Carrier for prior-turn context exposed to strategy hooks. Hooks
 *  use this to render a `<previous_turn_rendered>` block from the
 *  authoritative `uiTrail` so the model sees its own past renders. */
export interface RendererStrategyPrev {
    uiTrail?: UiTrailEntry[];
}

export interface RendererPromptStrategy {
    /** First turn of a fresh conversation. Default: pass `input.text`
     *  through unchanged. No `prev` — there is no prior trail. */
    forNew?(input: RendererInput & { kind: 'new_message' }): string;
    /** Follow-up turn after a clean `completed`. */
    forCompleted?(
        input: RendererInput & { kind: 'new_message' },
        prev: RendererStrategyPrev,
    ): string;
    /** Human interrupted a running agent turn with a new message. */
    forRunningPreempted?(
        input: RendererInput & { kind: 'new_message' },
        prev: RendererStrategyPrev,
    ): string;
    /** Human responded to a HITL pause as the agent requested
     *  (button click, form submit). Default: materialize the agent's
     *  `resumePrompt` template against `input.value`. No `prev` arg —
     *  the resumed turn is materialized via `resumePrompt`, which is
     *  the agent's own framing of its prior emission. */
    forAwaitingInputResolved?(
        input: RendererInput & { kind: 'hitl_response' },
        pending: PendingHitlRecord,
    ): string;
    /** Human ignored the HITL prompt and sent a new message instead. */
    forAwaitingInputPreempted?(
        input: RendererInput & { kind: 'new_message' },
        pending: PendingHitlRecord | undefined,
        prev: RendererStrategyPrev,
    ): string;
    /** Follow-up turn after an `errored` prior turn. */
    forErrored?(
        input: RendererInput & { kind: 'new_message' },
        error: { code: string; message: string } | undefined,
        prev: RendererStrategyPrev,
    ): string;
    /** Follow-up turn after a `canceled` prior turn. */
    forCanceled?(
        input: RendererInput & { kind: 'new_message' },
        prev: RendererStrategyPrev,
    ): string;
}

/**
 * The action the renderer applies after consulting the state machine.
 * Carries the **materialized prompt** (composed via the strategy) so
 * the renderer's only remaining job is dispatch — no per-tier prompt
 * scaffolding lives outside the strategy hooks.
 */
export type RendererAction =
    | {
          kind: 'dispatch_new';
          prompt: string;
          reason: 'no_prior_state';
      }
    | {
          kind: 'dispatch_continuation';
          prompt: string;
          /** SDK session id to resume; `undefined` only when there is
           *  no prior session (degenerate — `dispatch_new` covers the
           *  normal first-turn case). */
          resumeSessionId?: string;
          reason: ConversationStatus | 'hitl_resolved' | 'preempt_awaiting_input';
      }
    | {
          kind: 'abort_then_continuation';
          /** Active run to abort first. */
          abortRunId: string;
          prompt: string;
          resumeSessionId?: string;
          reason: 'preempt_running' | 'preempt_awaiting_input';
      };

/** Scalar serializer used by the default-resume substitution helper. */
function scalar(v: unknown): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

/**
 * Default strategy — sensible-but-spartan fallbacks. Renderers
 * override the hooks where they have surface-specific context to
 * inject (Slack: channel id + files block; Tier-B: convId; …).
 *
 * `forAwaitingInputResolved` defaults to inlining the lib's
 * `materializeResumePrompt` — that's the agent-authored template
 * substitution. Renderers rarely override this hook; the agent owns it.
 */
export const defaultRendererStrategy: Required<RendererPromptStrategy> = {
    forNew: (input) => input.text,
    // Default hooks IGNORE `prev` — uiTrail rendering is opt-in at the
    // renderer level (each renderer composes its own preamble).
    forCompleted: (input, _prev) => input.text,
    forRunningPreempted: (input, _prev) =>
        `[The user interrupted your previous response with a new message:]\n\n${input.text}`,
    forAwaitingInputResolved: (input, pending) => {
        const template = pending.resumePrompt;
        if (!template || template.length === 0) {
            return `The user responded: ${scalar(input.value)}`;
        }
        // Inline substitution — same algorithm as `materializeResumePrompt`
        // in `hitl.ts` (re-exported from the package root). Kept here
        // so this module has no cross-file dep at runtime.
        let out = template.replace(/\{value\}/g, scalar(input.value));
        if (
            input.value &&
            typeof input.value === 'object' &&
            !Array.isArray(input.value)
        ) {
            for (const [field, fieldValue] of Object.entries(
                input.value as Record<string, unknown>,
            )) {
                const placeholder = new RegExp(
                    `\\{${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`,
                    'g',
                );
                out = out.replace(placeholder, scalar(fieldValue));
            }
        }
        return out;
    },
    forAwaitingInputPreempted: (input, _pending, _prev) =>
        `[The user did not respond to your earlier question. Instead, they sent a new message — drop the prior request and follow their new direction:]\n\n${input.text}`,
    forErrored: (input, error, _prev) =>
        `[Your previous turn errored${
            error ? `: ${error.message}` : ''
        }. The user now writes:]\n\n${input.text}`,
    forCanceled: (input, _prev) =>
        `[Your previous turn was canceled. The user now writes:]\n\n${input.text}`,
};

/**
 * Merge a renderer-provided partial strategy with the lib defaults
 * into a fully-populated strategy. Pure; the result is what
 * `decideRendererAction` consults.
 */
export function composeStrategy(
    custom: RendererPromptStrategy | undefined,
): Required<RendererPromptStrategy> {
    if (!custom) return defaultRendererStrategy;
    return {
        forNew: custom.forNew ?? defaultRendererStrategy.forNew,
        forCompleted: custom.forCompleted ?? defaultRendererStrategy.forCompleted,
        forRunningPreempted:
            custom.forRunningPreempted ?? defaultRendererStrategy.forRunningPreempted,
        forAwaitingInputResolved:
            custom.forAwaitingInputResolved ??
            defaultRendererStrategy.forAwaitingInputResolved,
        forAwaitingInputPreempted:
            custom.forAwaitingInputPreempted ??
            defaultRendererStrategy.forAwaitingInputPreempted,
        forErrored: custom.forErrored ?? defaultRendererStrategy.forErrored,
        forCanceled: custom.forCanceled ?? defaultRendererStrategy.forCanceled,
    };
}

/**
 * Pure state-machine evaluator: given the loaded conversation state
 * (or `undefined` for a fresh conversation), the renderer's typed
 * `RendererInput`, and a (possibly partial) strategy, decide which
 * dispatch action to apply AND compose the next agent turn's prompt
 * via the strategy hooks.
 *
 * The whole point: a renderer's per-event handler is just:
 *
 *   const action = decideRendererAction(state, input, MY_STRATEGY);
 *   if (action.kind === 'abort_then_continuation')
 *       await engine.abortRun(action.abortRunId);
 *   await engine.dispatchAgentTurn({
 *       workdir, prompt: action.prompt,
 *       resumeSessionId: action.resumeSessionId,
 *   });
 *
 * — no per-tier state-machine duplication, no prompt scaffolding
 * leaking out of the strategy module.
 */
export function decideRendererAction(
    state: ConversationState | undefined,
    input: RendererInput,
    customStrategy?: RendererPromptStrategy,
): RendererAction {
    const strategy = composeStrategy(customStrategy);
    const sessionId = state?.sessionId;
    // `prev` carries the authoritative ui trail so hooks can render
    // a `<previous_turn_rendered>` block from the engine's own ground
    // truth (not the SDK conversation tree's resumed-turn noise).
    const prev: RendererStrategyPrev = state?.uiTrail
        ? { uiTrail: state.uiTrail }
        : {};

    // ── HITL response — must match the pending pause's promptId ───
    if (input.kind === 'hitl_response') {
        if (
            state?.status === 'awaiting_input' &&
            state.pendingHitl &&
            state.pendingHitl.promptId === input.promptId
        ) {
            return {
                kind: 'dispatch_continuation',
                prompt: strategy.forAwaitingInputResolved(input, state.pendingHitl),
                ...(sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
                reason: 'hitl_resolved',
            };
        }
        // Stale HITL response (the pause was already superseded /
        // resumed elsewhere / the run was canceled). Treat as a
        // new-message turn carrying the value's string form.
        return decideRendererAction(
            state,
            {
                kind: 'new_message',
                text: scalar(input.value),
                ...(input.metadata ? { metadata: input.metadata } : {}),
            },
            customStrategy,
        );
    }

    // ── new_message — branch by current conversation status ──────
    if (!state || state.status === 'new') {
        return {
            kind: 'dispatch_new',
            prompt: strategy.forNew(input),
            reason: 'no_prior_state',
        };
    }
    if (state.status === 'running' && state.activeRunId) {
        return {
            kind: 'abort_then_continuation',
            abortRunId: state.activeRunId,
            prompt: strategy.forRunningPreempted(input, prev),
            ...(sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
            reason: 'preempt_running',
        };
    }
    if (state.status === 'awaiting_input') {
        const prompt = strategy.forAwaitingInputPreempted(input, state.pendingHitl, prev);
        if (state.activeRunId) {
            return {
                kind: 'abort_then_continuation',
                abortRunId: state.activeRunId,
                prompt,
                ...(sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
                reason: 'preempt_awaiting_input',
            };
        }
        return {
            kind: 'dispatch_continuation',
            prompt,
            ...(sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
            reason: 'preempt_awaiting_input',
        };
    }
    // completed | errored | canceled — clean continuation.
    const continuationPrompt =
        state.status === 'errored'
            ? strategy.forErrored(input, state.lastError, prev)
            : state.status === 'canceled'
                ? strategy.forCanceled(input, prev)
                : strategy.forCompleted(input, prev);
    return {
        kind: 'dispatch_continuation',
        prompt: continuationPrompt,
        ...(sessionId !== undefined ? { resumeSessionId: sessionId } : {}),
        reason: state.status,
    };
}
