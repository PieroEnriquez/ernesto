/**
 * Cursor `Run` → canonical `RunHandle` wrapper.
 *
 * Source of truth for the SDK shape:
 *   `node_modules/@cursor/sdk/dist/esm/run.d.ts` (`Run`, `RunResult`)
 *   `node_modules/@cursor/sdk/dist/esm/agent.d.ts` (`SendOptions`)
 *
 * Cursor's `agent.send(message, options)` returns a `Run` whose
 * `stream()` is an `AsyncGenerator<SDKMessage>`. We wrap it into a
 * canonical `RunHandle` whose `stream()` yields `HarnessEvent` and
 * whose `wait()` resolves to `RunResult`. Cancel is best-effort
 * (Cursor's cancel is turn-boundary — see
 * `capabilities.midResponseCancel = false`).
 */

import debug from 'debug';
import type {
    Run as CursorRun,
    SDKAgent,
    SendOptions as CursorSendOptions,
    SDKMessage as CursorSDKMessage,
    InteractionUpdate,
} from '@cursor/sdk';
import type {
    AssistantBlock,
    HarnessEvent,
    RunHandle,
    RunResult,
    RunStatus,
} from '../types';
import {
    createTranslatorState,
    mapCursorDelta,
    mapCursorMessage,
} from './events';

const log = debug('ernesto:harness:cursor:send');

/** Per-send options accepted by `cursorSend` / `cursorSendWithAgent`. */
export interface CursorSendOptionsExt {
    /** Pre-built Cursor send options to thread through. The harness
     *  builds these from `AgentDefinition.outputFormat`, per-send MCP
     *  overrides, etc. */
    cursorOptions?: CursorSendOptions;
    /** Caller-supplied run id used in emitted events; Cursor's own
     *  `Run.id` lives alongside. */
    runId: string;
    /** Tap each raw `SDKMessage` from Cursor's stream. Mirrors
     *  `casCreateAgent`'s `onRawMessage`. */
    onRawMessage?: (msg: CursorSDKMessage) => void;
    /** Tap each `InteractionUpdate` delivered via Cursor's onDelta
     *  callback. The harness wires `cursorOptions.onDelta` to its own
     *  internal forwarder; callers that want their own observer chain
     *  in addition pass it here. */
    onDelta?: (update: InteractionUpdate) => void;
}

/** Inputs to {@link cursorSend} — start a Cursor run from a fresh
 *  `Agent.create` call per send. Reusable via the `Agent` handle
 *  returned by `cursorCreateAgent`; this entry point exists for
 *  one-shot tests / scripts where create + send happen together. */
export interface CursorSendInput extends CursorSendOptionsExt {
    /** A live `SDKAgent` handle. `cursorCreateAgent` produces one;
     *  callers can pass any conforming instance (tests use a mock). */
    agent: SDKAgent;
    /** User text prompt. Attachments use the structured shape
     *  (`SDKUserMessage`) — pass via `cursorOptions` or extend later. */
    prompt: string;
}

/**
 * Start a Cursor run via a live `SDKAgent`, returning a canonical
 * `RunHandle`. Symmetric to `casSendWithOptions` — the agent factory
 * is opt-in, this just kicks off `agent.send(prompt)`.
 */
export async function cursorSend(input: CursorSendInput): Promise<RunHandle> {
    const { agent, prompt, runId, cursorOptions, onRawMessage, onDelta } = input;
    log('starting Cursor run', { runId });

    // Wire onDelta into the buffer so per-token deltas land in the
    // canonical stream alongside the SDKMessage-derived events.
    const buffered: HarnessEvent[] = [];
    let cursorRun: CursorRun | undefined;
    let status: RunStatus = 'running';
    const statusListeners = new Set<(s: RunStatus) => void>();
    const setStatus = (next: RunStatus): void => {
        if (status === next) return;
        status = next;
        for (const fn of statusListeners) fn(next);
    };

    const composedOptions: CursorSendOptions = {
        ...(cursorOptions ?? {}),
        onDelta: ({ update }) => {
            try {
                if (onDelta) onDelta(update);
            } catch (cbErr) {
                log('user onDelta threw', cbErr);
            }
            const ev = mapCursorDelta(update, runId);
            if (ev) buffered.push(ev);
            // Chain caller's own onDelta if they passed one through
            // cursorOptions (so the SDK consumer chain stays intact).
            const upstream = cursorOptions?.onDelta;
            if (upstream) {
                try {
                    void upstream({ update });
                } catch (cbErr) {
                    log('upstream onDelta threw', cbErr);
                }
            }
        },
    };

    cursorRun = await agent.send(prompt, composedOptions);

    return buildRunHandle({
        cursorRun,
        runId,
        buffered,
        setStatus,
        statusListeners,
        currentStatus: () => status,
        setStatusFn: setStatus,
        onRawMessage,
    });
}

/** Convenience: pre-built handle wrapper. Symmetric to
 *  `casQueryToRunHandle`. Useful for tests that mock `cursorRun`
 *  directly. */
export interface CursorRunToHandleOptions {
    runId: string;
    onRawMessage?: (msg: CursorSDKMessage) => void;
}

export function cursorRunToRunHandle(
    cursorRun: CursorRun,
    opts: CursorRunToHandleOptions,
): RunHandle {
    const buffered: HarnessEvent[] = [];
    let status: RunStatus = 'running';
    const statusListeners = new Set<(s: RunStatus) => void>();
    const setStatus = (next: RunStatus): void => {
        if (status === next) return;
        status = next;
        for (const fn of statusListeners) fn(next);
    };
    return buildRunHandle({
        cursorRun,
        runId: opts.runId,
        buffered,
        setStatus,
        statusListeners,
        currentStatus: () => status,
        setStatusFn: setStatus,
        onRawMessage: opts.onRawMessage,
    });
}

interface BuildRunHandleInput {
    cursorRun: CursorRun;
    runId: string;
    buffered: HarnessEvent[];
    setStatus: (s: RunStatus) => void;
    statusListeners: Set<(s: RunStatus) => void>;
    currentStatus: () => RunStatus;
    setStatusFn: (s: RunStatus) => void;
    onRawMessage?: (msg: CursorSDKMessage) => void;
}

function buildRunHandle(args: BuildRunHandleInput): RunHandle {
    const {
        cursorRun,
        runId,
        buffered,
        statusListeners,
        currentStatus,
        setStatusFn,
        onRawMessage,
    } = args;

    let drainPromise: Promise<void> | null = null;
    let drainDone = false;

    const ensureDraining = (): Promise<void> => {
        if (drainPromise !== null) return drainPromise;
        drainPromise = (async () => {
            try {
                const state = createTranslatorState();
                for await (const sdkMsg of cursorRun.stream()) {
                    if (onRawMessage) {
                        try {
                            onRawMessage(sdkMsg);
                        } catch (cbErr) {
                            log('onRawMessage threw', cbErr);
                        }
                    }
                    for (const ev of mapCursorMessage(sdkMsg, runId, state)) {
                        buffered.push(ev);
                        if (ev.kind === 'status') setStatusFn(ev.status);
                    }
                }
                // Stream complete without a terminal status event?
                // Synthesize one from Cursor's `Run.status`.
                if (currentStatus() === 'running') {
                    const terminal = mapTerminal(cursorRun.status);
                    if (terminal) {
                        buffered.push({ kind: 'status', status: terminal, runId });
                        setStatusFn(terminal);
                    } else {
                        buffered.push({ kind: 'status', status: 'completed', runId });
                        setStatusFn('completed');
                    }
                }
            } catch (err) {
                log('cursor stream errored', err);
                const message = err instanceof Error ? err.message : String(err);
                buffered.push({ kind: 'error', message, recoverable: false, runId });
                buffered.push({ kind: 'status', status: 'errored', runId });
                setStatusFn('errored');
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
        let errorMessage: string | undefined;
        for (const ev of buffered) {
            if (ev.kind === 'assistant_message') {
                finalAssistant = ev.content;
            } else if (ev.kind === 'error') {
                errorMessage = ev.message;
            }
        }

        const cursorResult = await cursorRun.wait().catch(() => undefined);

        const terminal: RunResult['status'] =
            currentStatus() === 'canceled'
                ? 'canceled'
                : currentStatus() === 'errored'
                    ? 'errored'
                    : 'completed';

        const result: RunResult = {
            runId,
            status: terminal,
            finalAssistant,
            // Cursor doesn't expose token-level usage; populate the
            // canonical fields with zeros and let `costReporting=false`
            // on the capability matrix gate any UI that reads them.
            usage: { inputTokens: 0, outputTokens: 0 },
            durationMs:
                cursorResult && typeof cursorResult.durationMs === 'number'
                    ? cursorResult.durationMs
                    : durationMs,
        };
        if (cursorResult) {
            if (typeof cursorResult.result === 'string') {
                result.rawText = cursorResult.result;
            }
            if (typeof cursorResult.status === 'string') {
                result.subtype = cursorResult.status;
            }
        }
        if (errorMessage) {
            result.error = { message: errorMessage };
        }
        return result;
    };

    const cancel = async (): Promise<void> => {
        try {
            if (cursorRun.supports('cancel')) {
                await cursorRun.cancel();
            }
        } catch (err) {
            log('cursor cancel failed', err);
        }
        buffered.push({ kind: 'status', status: 'canceled', runId });
        setStatusFn('canceled');
    };

    const onStatusChange = (fn: (s: RunStatus) => void): (() => void) => {
        statusListeners.add(fn);
        return () => {
            statusListeners.delete(fn);
        };
    };

    return {
        id: runId,
        get status(): RunStatus {
            return currentStatus();
        },
        stream,
        wait,
        cancel,
        onStatusChange,
    };
}

function mapTerminal(cursorStatus: string): RunStatus | undefined {
    switch (cursorStatus) {
        case 'finished':
            return 'completed';
        case 'error':
            return 'errored';
        case 'cancelled':
            return 'canceled';
        default:
            return undefined;
    }
}
