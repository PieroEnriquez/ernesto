/**
 * Shared `RunHandle` state machine.
 *
 * Every agent adapter (cas, cursor, mock — and, by inspection,
 * fragua-pi) wraps a provider-native event source into the canonical
 * {@link RunHandle}. The mechanics are identical across adapters:
 *
 *   - a `status` cell + `onStatusChange` listener set + `setStatus`
 *     dedupe;
 *   - a single `buffered: HarnessEvent[]` broadcast buffer with a
 *     single-drain guard, so `stream()` and `wait()` can't race the
 *     underlying provider iterator;
 *   - `ensureDraining()` — walk the provider source once, map each
 *     message → `HarnessEvent[]`, push to the buffer, update status,
 *     and convert a thrown error into an `error` + `status: errored`
 *     pair;
 *   - `stream()` — replay the buffer and race the drain for incremental
 *     yield;
 *   - `wait()` — fold the buffer into
 *     `{ finalAssistant, usage, costUsd, errorMessage }`, compute the
 *     terminal status (`canceled` | `errored` | `completed`), and hand
 *     the fold to the adapter's `mapResult` for SDK-specific
 *     enrichment;
 *   - `cancel()` wiring.
 *
 * Only the genuinely per-backend pieces are hooks on
 * {@link HarnessAdapterSpec}: the row translator (`mapMessage`),
 * terminal enrichment (`mapResult`), raw-terminal capture (`isResult`),
 * stream finalization (`finalizeStream`), the cancel mechanism
 * (`cancel`), and the optional capability methods
 * (`steer` / `pause` / `resume` / `respondToHitl`).
 */

import debug from 'debug';
import type {
    AssistantBlock,
    HarnessEvent,
    RunHandle,
    RunResult,
    RunStatus,
} from './types';

const log = debug('ernesto:harness:run-handle');

/**
 * The terminal fold the base computes from the drained buffer. Common
 * across every adapter — the SDK-specific extras come from the adapter's
 * `mapResult`, which reads them off the captured raw terminal message.
 */
export interface TerminalFold {
    runId: string;
    /** Terminal status, already resolved from the live `status` cell:
     *  `canceled` if cancel fired, else `errored` if the stream errored,
     *  else `completed`. */
    status: RunResult['status'];
    /** Last `assistant_message` content seen on the stream, if any. */
    finalAssistant?: AssistantBlock[];
    /** Folded usage — last `usage` event wins for tokens, last numeric
     *  `costUsd` wins for cost. */
    usage: { inputTokens: number; outputTokens: number; costUsd?: number };
    /** Wall-clock ms measured around the drain inside `wait()`. Adapters
     *  may override with an SDK-authoritative duration in `mapResult`. */
    durationMs: number;
    /** Last `error` event message, if any. */
    errorMessage?: string;
}

/**
 * Per-adapter contract consumed by {@link makeRunHandle}. `Raw` is the
 * provider-native message type the adapter's source yields.
 *
 * THIS IS THE DELIVERABLE CONTRACT. An adapter that can express its
 * divergences from the common state machine purely through these hooks
 * needs no bespoke handle code.
 */
export interface HarnessAdapterSpec<Raw> {
    /** Caller-supplied run id, stamped into every emitted event. */
    runId: string;
    /** The provider event source. Walked exactly once by the base. */
    source: AsyncIterable<Raw>;
    /** Make the per-stream translator state the row mapper threads
     *  across rows (open tool calls, open subagents, `sawInit`, …).
     *  Opaque to the base. */
    createState(): unknown;
    /** Pure row translator: provider message → canonical events. The
     *  big per-backend discriminator switch lives in the adapter's
     *  `events.ts`; this just adapts its signature. */
    mapMessage(msg: Raw, runId: string, state: unknown): HarnessEvent[];
    /** Enrich the common terminal fold with SDK-specific fields
     *  (`apiDurationMs`, `modelUsage`, `subtype`, `rawText`,
     *  `structuredOutput`, `transcriptId`, authoritative `durationMs`, …).
     *  `raw` is the captured raw terminal message when `isResult`
     *  flagged one. The fold's `error` is already applied by the base
     *  unless the adapter overwrites it. May be async (cursor awaits the
     *  provider's own `wait()`). */
    mapResult(fold: TerminalFold, raw?: Raw): RunResult | Promise<RunResult>;
    /** Flag the raw terminal message so the base captures it for
     *  `mapResult`. cas: `msg.type === 'result'`. Omit when the adapter
     *  derives terminal data from elsewhere (cursor: provider `wait()`;
     *  fragua-pi: `agent.state.messages`). */
    isResult?(msg: Raw): boolean;
    /** Called once after the source drains *cleanly* (no throw), with
     *  the translator state and the live status. Returns extra events to
     *  append — used to synthesize a terminal status when the provider
     *  ended the stream without emitting one (cursor). The base appends
     *  the returned events and applies any `status` among them. */
    finalizeStream?(state: unknown, lastStatus: RunStatus): HarnessEvent[];
    /** Provider-native cancel. Best-effort; the base always appends
     *  `status: canceled` to the buffer and flips the status cell after
     *  this resolves/rejects. */
    cancel(): Promise<void>;
    /** Raw-message tap fired once per source message, before mapping.
     *  Mirrors the adapters' `onRawMessage`. Throwing is logged, not
     *  fatal. */
    onRawMessage?(msg: Raw): void;
    /** When true, the drain loop stops pushing further events once
     *  `cancel()` has fired (mock's cooperative early-out). Default:
     *  keep draining (cas/cursor let the provider settle). */
    stopOnCancel?: boolean;
    /** Optional pre-seeded broadcast buffer. The base appends to *this*
     *  array instead of a fresh one, so an adapter that must wire event
     *  sources before the handle exists (cursor's `onDelta` → buffer)
     *  shares a single buffer with the base. Defaults to a fresh `[]`. */
    buffered?: HarnessEvent[];

    // --- Optional capability methods, attached to the handle verbatim
    //     when present (gated by `HarnessCapabilities` on the frontend). ---
    /** Mid-run steering. Gated by `capabilities.steer`. */
    steer?(text: string): Promise<void>;
    /** Pause an in-flight run. Gated by `capabilities.pause`. */
    pause?(): Promise<void>;
    /** Resume a paused run. Gated by `capabilities.pause`. */
    resume?(): Promise<void>;
    /** Respond to a HITL prompt. Gated by `capabilities.hitl`. */
    respondToHitl?(input: unknown): Promise<void>;
}

/**
 * Build the canonical {@link RunHandle} from a {@link HarnessAdapterSpec}.
 * The provider source is walked lazily — nothing iterates until a
 * consumer calls `stream()` or `wait()`. `cancel()` is callable before
 * either (the spec's `cancel` is wired immediately).
 */
export function makeRunHandle<Raw>(spec: HarnessAdapterSpec<Raw>): RunHandle {
    const { runId } = spec;

    let status: RunStatus = 'running';
    const statusListeners = new Set<(s: RunStatus) => void>();
    const setStatus = (next: RunStatus): void => {
        if (status === next) return;
        status = next;
        for (const fn of statusListeners) fn(next);
    };

    const buffered: HarnessEvent[] = spec.buffered ?? [];
    let rawResult: Raw | undefined;
    let drainPromise: Promise<void> | null = null;
    let drainDone = false;
    let canceled = false;

    const ensureDraining = (): Promise<void> => {
        if (drainPromise !== null) return drainPromise;
        drainPromise = (async () => {
            const state = spec.createState();
            try {
                for await (const msg of spec.source) {
                    if (spec.stopOnCancel && canceled) break;
                    if (spec.isResult && spec.isResult(msg)) {
                        rawResult = msg;
                    }
                    if (spec.onRawMessage) {
                        try {
                            spec.onRawMessage(msg);
                        } catch (cbErr) {
                            log('onRawMessage callback threw', cbErr);
                        }
                    }
                    for (const ev of spec.mapMessage(msg, runId, state)) {
                        buffered.push(ev);
                        if (ev.kind === 'status') setStatus(ev.status);
                    }
                }
                // Clean drain — let the adapter synthesize a terminal
                // status if the source ended without one (cursor).
                if (spec.finalizeStream) {
                    for (const ev of spec.finalizeStream(state, status)) {
                        buffered.push(ev);
                        if (ev.kind === 'status') setStatus(ev.status);
                    }
                }
            } catch (err) {
                log('run source errored', err);
                const message = err instanceof Error ? err.message : String(err);
                buffered.push({
                    kind: 'error',
                    message,
                    recoverable: false,
                    runId,
                });
                buffered.push({ kind: 'status', status: 'errored', runId });
                setStatus('errored');
            } finally {
                drainDone = true;
            }
        })();
        return drainPromise;
    };

    const stream = async function* (): AsyncGenerator<HarnessEvent> {
        const drain = ensureDraining();
        let cursor = 0;
        while (true) {
            while (cursor < buffered.length) {
                yield buffered[cursor++]!;
            }
            if (drainDone) return;
            // The drain promise resolves only at termination; for
            // incremental progress we race a micro-tick.
            await Promise.race([
                drain,
                new Promise<void>((resolve) => setTimeout(resolve, 0)),
            ]);
        }
    };

    const wait = async (): Promise<RunResult> => {
        const startedAt = Date.now();
        await ensureDraining();
        const durationMs = Date.now() - startedAt;

        let finalAssistant: AssistantBlock[] | undefined;
        let inputTokens = 0;
        let outputTokens = 0;
        let costUsd: number | undefined;
        let errorMessage: string | undefined;

        for (const ev of buffered) {
            if (ev.kind === 'assistant_message') {
                finalAssistant = ev.content;
            } else if (ev.kind === 'usage') {
                inputTokens = ev.inputTokens;
                outputTokens = ev.outputTokens;
                if (typeof ev.costUsd === 'number') costUsd = ev.costUsd;
            } else if (ev.kind === 'error') {
                errorMessage = ev.message;
            }
        }

        const terminal: RunResult['status'] =
            status === 'canceled'
                ? 'canceled'
                : status === 'errored'
                    ? 'errored'
                    : 'completed';

        const fold: TerminalFold = {
            runId,
            status: terminal,
            finalAssistant,
            usage: { inputTokens, outputTokens, costUsd },
            durationMs,
            errorMessage,
        };

        return spec.mapResult(fold, rawResult);
    };

    const cancel = async (): Promise<void> => {
        canceled = true;
        try {
            await spec.cancel();
        } catch (err) {
            log('adapter cancel failed', err);
        }
        buffered.push({ kind: 'status', status: 'canceled', runId });
        setStatus('canceled');
    };

    const onStatusChange = (fn: (s: RunStatus) => void): (() => void) => {
        statusListeners.add(fn);
        return () => {
            statusListeners.delete(fn);
        };
    };

    const handle: RunHandle = {
        id: runId,
        get status(): RunStatus {
            return status;
        },
        stream,
        wait,
        cancel,
        onStatusChange,
    };

    // Attach optional capability methods only when the adapter supplies
    // them — the canonical `RunHandle` leaves them `undefined` otherwise,
    // and frontends gate UI off the static capability matrix.
    if (spec.steer) handle.steer = spec.steer;
    if (spec.pause) handle.pause = spec.pause;
    if (spec.resume) handle.resume = spec.resume;
    if (spec.respondToHitl) handle.respondToHitl = spec.respondToHitl;

    return handle;
}
