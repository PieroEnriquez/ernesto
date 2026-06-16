/**
 * pi-agent-core `Agent` → canonical `RunHandle` wrapper.
 *
 * Source of truth for the SDK shape:
 *   `node_modules/@mariozechner/pi-agent-core/dist/agent.d.ts`
 *     - `Agent.prompt(message)` — start a run
 *     - `Agent.subscribe(listener)` — event tap
 *     - `Agent.abort()` / `Agent.waitForIdle()` — control
 *     - `Agent.steer(message)` — mid-run user injection
 *     - `Agent.state.messages` — final transcript
 *
 * pi-agent-core's event delivery is **callback-based** (`subscribe`),
 * not a generator. This file adapts the callback model into the
 * canonical pull-style `RunHandle.stream()` by pumping every event
 * into an array and yielding from the array as the consumer iterates.
 * Mirrors what `cursor/send.ts` does (Cursor's stream is itself an
 * `AsyncGenerator`, but the buffering wrapper is identical in spirit).
 *
 * **Steering / pause / HITL.** pi-agent-core has `Agent.steer(msg)`
 * (queues a user message for the next turn) but **no native pause /
 * resume / HITL surface** at this layer — those live in fragua's
 * workflow engine. The `FraguaPiRunHandle` exposes `steer()` for the
 * one capability pi-ai actually supports; the rest are documented gaps
 * in the harness capability matrix.
 */

import debug from 'debug';
import type { Agent as PiAgent, AgentEvent as PiAgentEvent, AgentMessage as PiAgentMessage } from '@mariozechner/pi-agent-core';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { AssistantBlock, HarnessEvent, RunHandle, RunResult, RunStatus } from '../types';
import { createTranslatorState, mapPiAgentEvent, mapStopReason } from './events';

const log = debug('ernesto:harness:fragua-pi:send');

/** Per-send extensions over the canonical input. */
export interface FraguaPiSendOptionsExt {
    /** Caller-supplied run id used in emitted events. */
    runId: string;
    /** Tap each raw pi-agent-core `AgentEvent` as it arrives. */
    onRawMessage?: (event: PiAgentEvent) => void;
}

/** Inputs to {@link fraguaPiSend}. */
export interface FraguaPiSendInput extends FraguaPiSendOptionsExt {
    /** A live pi-agent-core `Agent`. */
    agent: PiAgent;
    /** User text prompt. */
    prompt: string;
}

/** Wrapped-handle options — kept symmetric with `cursorRunToRunHandle`. */
export interface FraguaPiAgentToHandleOptions {
    runId: string;
    onRawMessage?: (event: PiAgentEvent) => void;
}

/**
 * The handle shape returned by `fraguaPiSend`. Extends the canonical
 * `RunHandle` with `steer()` (pi-agent-core supports it natively).
 * `pause` / `resume` / `respondToHitl` are intentionally absent — pi-ai
 * has no surface; consumers gate UI off `capabilities.pause` / `.hitl`.
 */
export interface FraguaPiRunHandle extends RunHandle {
    steer(text: string): Promise<void>;
}

/**
 * Start a pi-agent-core run via a live `Agent`, returning a canonical
 * `RunHandle`. Symmetric to `cursorSend` — the agent factory is opt-in;
 * this just kicks off `agent.prompt(text)` and pumps the event stream.
 */
export async function fraguaPiSend(input: FraguaPiSendInput): Promise<FraguaPiRunHandle> {
    const { agent, prompt, runId, onRawMessage } = input;
    log('starting fragua-pi run', { runId });
    // Kick off the prompt without awaiting — the event stream is
    // already being subscribed by `fraguaPiAgentToRunHandle` below.
    return fraguaPiAgentToRunHandle(agent, runId, {
        runId,
        ...(onRawMessage !== undefined ? { onRawMessage } : {}),
        startPrompt: prompt,
    });
}

interface InternalToHandleOptions extends FraguaPiAgentToHandleOptions {
    /** If set, the wrapper calls `agent.prompt(startPrompt)` after
     *  installing its `subscribe` listener. Skipped when the agent has
     *  already been prompted (e.g. tests that pre-populate state). */
    startPrompt?: string;
}

/**
 * Wrap an already-running (or about-to-run) pi-agent-core `Agent` into
 * a canonical `RunHandle`. The wrapper installs a single
 * `agent.subscribe` listener and pumps every event into a buffer the
 * consumer drains via `stream()`.
 */
export function fraguaPiAgentToRunHandle(agent: PiAgent, runId: string, opts: InternalToHandleOptions): FraguaPiRunHandle {
    const buffered: HarnessEvent[] = [];
    let status: RunStatus = 'running';
    const statusListeners = new Set<(s: RunStatus) => void>();
    const setStatus = (next: RunStatus): void => {
        if (status === next) return;
        status = next;
        for (const fn of statusListeners) fn(next);
    };

    const state = createTranslatorState();
    let runDone = false;
    let runError: unknown;
    let resolveRunDone: () => void = () => {};
    const runDonePromise = new Promise<void>((resolve) => {
        resolveRunDone = resolve;
    });

    const unsubscribe = agent.subscribe((ev) => {
        try {
            if (opts.onRawMessage) {
                try {
                    opts.onRawMessage(ev);
                } catch (cbErr) {
                    log('onRawMessage threw', cbErr);
                }
            }
            for (const out of mapPiAgentEvent(ev, runId, state)) {
                buffered.push(out);
                if (out.kind === 'status') setStatus(out.status);
            }
            if (ev.type === 'agent_end') {
                runDone = true;
                resolveRunDone();
            }
        } catch (err) {
            log('subscribe handler errored', err);
            runError = err;
            runDone = true;
            resolveRunDone();
        }
    });

    // Kick off the prompt — fire-and-forget, await is via wait().
    const promptPromise =
        opts.startPrompt !== undefined
            ? (async () => {
                  try {
                      await agent.prompt(opts.startPrompt as string);
                      await agent.waitForIdle();
                  } catch (err) {
                      log('agent.prompt threw', err);
                      runError = err;
                      // If `agent_end` didn't fire, synthesize a terminal
                      // status so the stream still completes.
                      if (!runDone) {
                          const message = err instanceof Error ? err.message : String(err);
                          buffered.push({
                              kind: 'error',
                              message,
                              recoverable: false,
                              runId,
                          });
                          buffered.push({
                              kind: 'status',
                              status: 'errored',
                              runId,
                          });
                          setStatus('errored');
                          runDone = true;
                          resolveRunDone();
                      }
                  }
              })()
            : Promise.resolve();

    const stream = async function* (): AsyncGenerator<HarnessEvent> {
        let cursor = 0;
        while (true) {
            while (cursor < buffered.length) {
                yield buffered[cursor++]!;
            }
            if (runDone) return;
            await Promise.race([runDonePromise, new Promise<void>((resolve) => setTimeout(resolve, 0))]);
        }
    };

    const wait = async (): Promise<RunResult> => {
        const startedAt = Date.now();
        await promptPromise;
        await runDonePromise;
        unsubscribe();
        const durationMs = Date.now() - startedAt;

        // Walk the agent's final transcript to pick the trailing
        // assistant message — that's where stopReason + usage live.
        let finalAssistant: AssistantBlock[] | undefined;
        let usageInput = 0;
        let usageOutput = 0;
        let costUsd: number | undefined;
        let stopReason: string | undefined;
        let rawText: string | undefined;
        let errorMessage: string | undefined;
        const messages = agent.state.messages as PiAgentMessage[];
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (isAssistant(m)) {
                stopReason = m.stopReason;
                if (m.errorMessage) errorMessage = m.errorMessage;
                finalAssistant = extractAssistantBlocks(m);
                rawText = extractText(m);
                if (m.usage) {
                    usageInput = m.usage.input ?? 0;
                    usageOutput = m.usage.output ?? 0;
                    if (m.usage.cost && typeof m.usage.cost.total === 'number') {
                        costUsd = m.usage.cost.total;
                    }
                }
                break;
            }
        }

        const terminal: RunResult['status'] =
            status === 'canceled'
                ? 'canceled'
                : status === 'errored' || (stopReason === 'error' && errorMessage !== undefined)
                  ? 'errored'
                  : mapStopReason(stopReason) === 'canceled'
                    ? 'canceled'
                    : 'completed';

        const result: RunResult = {
            runId,
            status: terminal,
            usage: {
                inputTokens: usageInput,
                outputTokens: usageOutput,
                ...(costUsd !== undefined ? { costUsd } : {}),
            },
            durationMs,
        };
        if (finalAssistant !== undefined) result.finalAssistant = finalAssistant;
        if (rawText !== undefined) result.rawText = rawText;
        if (stopReason !== undefined) result.subtype = stopReason;
        if (errorMessage !== undefined) {
            result.error = {
                message: errorMessage,
                ...(runError !== undefined ? { cause: runError } : {}),
            };
        } else if (runError !== undefined) {
            const message = runError instanceof Error ? runError.message : String(runError);
            result.error = { message, cause: runError };
        }
        return result;
    };

    const cancel = async (): Promise<void> => {
        try {
            agent.abort();
        } catch (err) {
            log('agent.abort threw', err);
        }
        buffered.push({ kind: 'status', status: 'canceled', runId });
        setStatus('canceled');
        // Don't wait for the agent to settle here — pi-agent-core
        // surfaces `aborted` via `agent_end`'s trailing message; the
        // canceled status is already in the buffer for early consumers.
    };

    const steer = async (text: string): Promise<void> => {
        // pi-agent-core accepts an `AgentMessage`; we wrap text as a
        // user message with the current timestamp. Errors here are
        // not fatal — log + ignore.
        try {
            agent.steer({
                role: 'user',
                content: text,
                timestamp: Date.now(),
            });
        } catch (err) {
            log('agent.steer threw', err);
            throw err;
        }
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
            return status;
        },
        stream,
        wait,
        cancel,
        steer,
        onStatusChange,
    };
}

function isAssistant(m: PiAgentMessage): m is AssistantMessage {
    const mm = m as {
        role?: string;
        content?: unknown;
        usage?: unknown;
    };
    return mm.role === 'assistant' && Array.isArray(mm.content) && typeof mm.usage === 'object' && mm.usage !== null;
}

function extractAssistantBlocks(msg: AssistantMessage): AssistantBlock[] {
    const out: AssistantBlock[] = [];
    for (const block of msg.content) {
        if (block.type === 'text') {
            out.push({ type: 'text', text: block.text });
        } else if (block.type === 'thinking') {
            out.push({ type: 'thinking', text: block.thinking });
        } else if (block.type === 'toolCall') {
            out.push({
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: block.arguments ?? {},
            });
        }
    }
    return out;
}

function extractText(msg: AssistantMessage): string {
    const parts: string[] = [];
    for (const block of msg.content) {
        if (block.type === 'text') parts.push(block.text);
    }
    return parts.join('');
}
