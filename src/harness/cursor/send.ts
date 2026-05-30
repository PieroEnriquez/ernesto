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
    HarnessEvent,
    RunHandle,
    RunResult,
    RunStatus,
} from '../types';
import { makeRunHandle, type TerminalFold } from '../run-handle';
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
    // canonical stream alongside the SDKMessage-derived events. The
    // buffer is created here, before `agent.send`, and handed to the
    // base via `spec.buffered` so the delta callback and the drain
    // share one broadcast buffer.
    const buffered: HarnessEvent[] = [];
    let cursorRun: CursorRun | undefined;

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
        ...(onRawMessage ? { onRawMessage } : {}),
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
    return buildRunHandle({
        cursorRun,
        runId: opts.runId,
        buffered: [],
        ...(opts.onRawMessage ? { onRawMessage: opts.onRawMessage } : {}),
    });
}

interface BuildRunHandleInput {
    cursorRun: CursorRun;
    runId: string;
    /** Broadcast buffer, pre-seeded so cursor's `onDelta`-driven deltas
     *  (wired before this handle exists) share the base's drain buffer. */
    buffered: HarnessEvent[];
    onRawMessage?: (msg: CursorSDKMessage) => void;
}

function buildRunHandle(args: BuildRunHandleInput): RunHandle {
    const { cursorRun, runId, buffered, onRawMessage } = args;

    // Cursor's terminal data (durationMs, result text, status subtype)
    // comes from the provider's own `wait()`, not the raw stream — so
    // `mapResult` awaits it rather than reading a captured raw message.
    const mapResult = async (fold: TerminalFold): Promise<RunResult> => {
        const cursorResult = await cursorRun.wait().catch(() => undefined);
        const result: RunResult = {
            runId: fold.runId,
            status: fold.status,
            finalAssistant: fold.finalAssistant,
            // Cursor doesn't expose token-level usage; the fold carries
            // zeros and `costReporting=false` gates any UI reading them.
            usage: fold.usage,
            durationMs:
                cursorResult && typeof cursorResult.durationMs === 'number'
                    ? cursorResult.durationMs
                    : fold.durationMs,
        };
        if (cursorResult) {
            if (typeof cursorResult.result === 'string') {
                result.rawText = cursorResult.result;
            }
            if (typeof cursorResult.status === 'string') {
                result.subtype = cursorResult.status;
            }
        }
        if (fold.errorMessage) {
            result.error = { message: fold.errorMessage };
        }
        return result;
    };

    return makeRunHandle<CursorSDKMessage>({
        runId,
        buffered,
        source: cursorRun.stream(),
        createState: createTranslatorState,
        mapMessage: (msg, id, state) =>
            mapCursorMessage(
                msg,
                id,
                state as ReturnType<typeof createTranslatorState>,
            ),
        ...(onRawMessage ? { onRawMessage } : {}),
        // Cursor may end the stream without a terminal status event —
        // synthesize one from `Run.status` (defaulting to `completed`).
        finalizeStream: (_state, lastStatus) => {
            if (lastStatus !== 'running') return [];
            const terminal = mapTerminal(cursorRun.status) ?? 'completed';
            return [{ kind: 'status', status: terminal, runId }];
        },
        cancel: async () => {
            if (cursorRun.supports('cancel')) {
                await cursorRun.cancel();
            }
        },
        mapResult,
    });
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
