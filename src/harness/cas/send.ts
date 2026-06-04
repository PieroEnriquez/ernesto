/**
 * CAS `Query` → `RunHandle` wrapper.
 *
 * The `RunHandle` returned by `casSend` is lazy: the underlying SDK
 * `Query` is created eagerly (so cancel/interrupt is wired immediately)
 * but the event stream is only walked when a consumer iterates
 * `stream()`. `wait()` collects terminal state by draining the stream
 * into a `RunResult`.
 */

import debug from 'debug';
import { query as casQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
    Options,
    Query,
    SDKMessage,
    SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { CompiledAgent } from '../../managed-agents/types';
import type {
    AssistantBlock,
    RunHandle,
    RunResult,
} from '../types';
import { makeRunHandle } from '../run-handle';
import { compileAgentToSdkOptions, type CompileContext } from './compile';
import { createTranslatorState, mapSdkMessage } from './events';

const log = debug('ernesto:harness:cas:send');

/** Options to start a CAS run. */
export interface CasSendOptions {
    compiled: CompiledAgent;
    prompt: string;
    runId: string;
    ctx: CompileContext;
    /** Optional raw-SDK tap forwarded to the underlying drain. Lets
     *  callers that still need SDK-shape in-flight access (subagent
     *  per-turn formatting, etc.) observe each `SDKMessage` without
     *  double-iterating the SDK Query. */
    onRawMessage?: (msg: SDKMessage) => void;
}

/** Internal inputs to {@link mapResult}. */
export interface MapResultInput {
    runId: string;
    status: RunResult['status'];
    finalAssistant?: AssistantBlock[];
    usage: { inputTokens: number; outputTokens: number; costUsd?: number };
    durationMs: number;
    errorMessage?: string;
    /** Raw SDK result message, when one arrived before stream end.
     *  Source of the harness-specific extras: `apiDurationMs`,
     *  `modelUsage`, `subtype`, `rawText`, `structuredOutput`. */
    sdkResult?: SDKResultMessage;
}

/**
 * Compose the canonical `RunResult` from the drained-stream snapshot
 * plus the raw SDK result message (when present). Pure — exported for
 * unit testing.
 *
 * Populates the optional `apiDurationMs` / `modelUsage` / `subtype` /
 * `rawText` / `structuredOutput` fields when the SDK result carries
 * them; leaves them unset otherwise so consumers can distinguish
 * "missing" from "zero".
 */
export function mapResult(input: MapResultInput): RunResult {
    const {
        runId,
        status,
        finalAssistant,
        usage,
        durationMs,
        errorMessage,
        sdkResult,
    } = input;

    const result: RunResult = {
        runId,
        status,
        finalAssistant,
        usage,
        durationMs,
    };

    if (sdkResult) {
        if (typeof sdkResult.duration_ms === 'number') {
            // Prefer the SDK's authoritative duration over the
            // wall-clock fallback the caller measured around `wait()`.
            // The wall-clock value tends to be a few ms larger because
            // it includes our drain overhead.
            result.durationMs = sdkResult.duration_ms;
        }
        if (typeof sdkResult.duration_api_ms === 'number') {
            result.apiDurationMs = sdkResult.duration_api_ms;
        }
        if (sdkResult.modelUsage && typeof sdkResult.modelUsage === 'object') {
            const modelUsage: NonNullable<RunResult['modelUsage']> = {};
            for (const [model, mu] of Object.entries(sdkResult.modelUsage)) {
                if (mu && typeof mu === 'object') {
                    const entry: { inputTokens: number; outputTokens: number; costUsd?: number } = {
                        inputTokens: mu.inputTokens ?? 0,
                        outputTokens: mu.outputTokens ?? 0,
                    };
                    if (typeof mu.costUSD === 'number') {
                        entry.costUsd = mu.costUSD;
                    }
                    modelUsage[model] = entry;
                }
            }
            result.modelUsage = modelUsage;
        }
        if (typeof sdkResult.subtype === 'string') {
            result.subtype = sdkResult.subtype;
        }
        // The Agent SDK's `session_id` lands on every SDKMessage
        // including the terminal result. Surface it as our transcript id
        // so the backend can persist the SDK's auto-generated UUID and
        // pass it back as `resumeTranscript` next turn.
        const transcriptId = (sdkResult as { session_id?: unknown }).session_id;
        if (typeof transcriptId === 'string') {
            result.transcriptId = transcriptId;
        }
        // `SDKResultSuccess.result` is the SDK-typed carrier; some
        // adapters / fixtures also stamp a `result` string on the error
        // shape (carries the failure detail). Honor both when present
        // so the canonical `rawText` is a single source of truth for
        // "the SDK's preferred result string" regardless of subtype.
        const rawText = (sdkResult as { result?: unknown }).result;
        if (typeof rawText === 'string') {
            result.rawText = rawText;
        }
        // `structured_output` also only on `SDKResultSuccess`. This is
        // the gap-3 fix — historically dropped on the floor.
        if (
            sdkResult.subtype === 'success' &&
            sdkResult.structured_output !== undefined
        ) {
            result.structuredOutput = sdkResult.structured_output;
        }
    }

    if (errorMessage) {
        result.error = { message: errorMessage };
    }
    return result;
}

/** Optional inputs to {@link casQueryToRunHandle}. */
export interface CasQueryToRunHandleOptions {
    /** Fires once per raw SDK message during the internal drain. Lets
     *  consumers that still need raw SDK-shape in-flight events (e.g.
     *  callers that haven't fully migrated to `HarnessEvent` yet) tap
     *  into the same stream the `RunHandle` is draining — no double
     *  iteration of the underlying SDK iterator. */
    onRawMessage?: (msg: SDKMessage) => void;
}

/**
 * Wrap an already-started SDK `Query` (or any `AsyncIterable<SDKMessage>`
 * that quacks like one) into a canonical `RunHandle`. Exposed so backend
 * call sites that already start their own SDK query — e.g. through a
 * pre-existing `executeWorkflow` indirection that can't easily be
 * inverted — can opt into `RunHandle.wait()` without re-plumbing the
 * query origin through `casSend`.
 *
 * The `cancel()` semantics are best-effort: if the underlying iterable
 * has a `.interrupt()` method (i.e. it's a real SDK `Query`), that's
 * called; otherwise cancel just flips status and stops yielding.
 */
export function casQueryToRunHandle(
    sdkQuery: AsyncIterable<unknown> & { interrupt?: () => Promise<void> },
    runId: string,
    opts: CasQueryToRunHandleOptions = {},
): RunHandle {
    return buildRunHandle(sdkQuery, runId, opts);
}

/**
 * Start a CAS run. Returns a `RunHandle` synchronously (well, post
 * SDK-options compile — no awaits). The underlying `Query` is created
 * here so `cancel()` is callable before anyone iterates `stream()`.
 */
export function casSend(opts: CasSendOptions): RunHandle {
    const { compiled, prompt, runId, ctx, onRawMessage } = opts;
    const sdkOptions = compileAgentToSdkOptions(compiled, ctx);
    log('starting CAS run', { runId, model: compiled.model });

    const sdkQuery: Query = casQuery({ prompt, options: sdkOptions });
    return buildRunHandle(sdkQuery, runId, { onRawMessage });
}

/** Options to start a CAS run from a pre-built SDK `Options`. The
 *  create-then-send split (`casCreateAgent` → `agent.send`) avoids
 *  re-running the `compileAgentToSdkOptions` step on every send. */
export interface CasSendWithOptionsInput {
    options: Options;
    prompt: string;
    runId: string;
    onRawMessage?: (msg: SDKMessage) => void;
}

/**
 * Start a CAS run with a pre-built SDK `Options` record. Used by
 * `casCreateAgent` to skip the redundant compile when an agent is
 * created up front and `send()` is invoked one or more times.
 */
export function casSendWithOptions(input: CasSendWithOptionsInput): RunHandle {
    const { options, prompt, runId, onRawMessage } = input;
    log('starting CAS run (pre-compiled)', {
        runId,
        model: typeof options.model === 'string' ? options.model : undefined,
    });
    const sdkQuery: Query = casQuery({ prompt, options });
    return buildRunHandle(sdkQuery, runId, { onRawMessage });
}

function buildRunHandle(
    sdkQuery: AsyncIterable<unknown> & { interrupt?: () => Promise<void> },
    runId: string,
    opts: CasQueryToRunHandleOptions,
): RunHandle {
    return makeRunHandle<SDKMessage>({
        runId,
        source: sdkQuery as AsyncIterable<SDKMessage>,
        createState: createTranslatorState,
        mapMessage: (msg, id, state) =>
            mapSdkMessage(msg, id, state as ReturnType<typeof createTranslatorState>),
        // Capture the SDK's terminal `result` row so `mapResult` can read
        // the SDK-specific extras (duration_api_ms, modelUsage, subtype,
        // result text, structured_output, session_id) off it.
        isResult: (msg) => msg.type === 'result',
        ...(opts.onRawMessage ? { onRawMessage: opts.onRawMessage } : {}),
        // CAS interrupt is the provider cancel mechanism. Best-effort —
        // the base appends `status: canceled` and flips status regardless.
        cancel: async () => {
            if (typeof sdkQuery.interrupt === 'function') {
                await sdkQuery.interrupt();
            }
        },
        mapResult: (fold, raw) =>
            mapResult({
                runId: fold.runId,
                status: fold.status,
                ...(fold.finalAssistant !== undefined
                    ? { finalAssistant: fold.finalAssistant }
                    : {}),
                usage: fold.usage,
                durationMs: fold.durationMs,
                ...(fold.errorMessage !== undefined
                    ? { errorMessage: fold.errorMessage }
                    : {}),
                ...(raw ? { sdkResult: raw as SDKResultMessage } : {}),
            }),
    });
}
