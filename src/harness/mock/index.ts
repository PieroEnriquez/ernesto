/**
 * Mock harness — script-driven, no backend.
 *
 * Used in lib contract tests and downstream tests that need a harness
 * without an LLM round-trip. The mock can pretend to be any backend by
 * passing a partial `capabilities` override.
 */

import { randomUUID } from 'crypto';
import type {
    AgentDefinition,
    AgentHandle,
    CreateOptions,
    Harness,
    HarnessCapabilities,
    HarnessEvent,
    ModelInfo,
    RunHandle,
    RunResult,
    RunStatus,
    SendOptions,
    UserMessage,
} from '../types';

/** Inputs the script function receives per `send()` call. */
export interface MockScriptInput {
    def: AgentDefinition;
    prompt: string;
    turnIndex: number;
    /** Run id the mock assigned. Scripts that emit events with a `runId`
     *  field should use this so downstream consumers can correlate. */
    runId: string;
}

/** Script signature — sync or async event source. */
export type MockScript = (
    input: MockScriptInput,
) => HarnessEvent[] | AsyncIterable<HarnessEvent>;

export interface MockHarnessOptions {
    capabilities?: Partial<HarnessCapabilities>;
    script?: MockScript;
    identifyAs?: { authed: boolean; principal?: string };
    models?: ModelInfo[];
}

/** Capabilities default — all-true so tests can shape down to any
 *  backend's matrix. */
const ALL_TRUE_CAPABILITIES: HarnessCapabilities = {
    perTokenDeltas: true,
    steer: true,
    pause: true,
    hitl: true,
    subagents: true,
    customFnTools: true,
    mcp: true,
    multiProvider: true,
    listMessages: true,
    listAgents: true,
    resume: true,
    attachments: true,
    costReporting: true,
    midResponseCancel: true,
    nativeStructuredOutput: true,
};

const DEFAULT_SCRIPT: MockScript = ({ runId }): HarnessEvent[] => {
    return [
        {
            kind: 'assistant_message',
            content: [{ type: 'text', text: 'mock response' }],
            runId,
        },
        {
            kind: 'usage',
            inputTokens: 1,
            outputTokens: 1,
            runId,
        },
        { kind: 'status', status: 'completed', runId },
    ];
};

export function createMockHarness(opts: MockHarnessOptions = {}): Harness {
    const capabilities: HarnessCapabilities = {
        ...ALL_TRUE_CAPABILITIES,
        ...(opts.capabilities ?? {}),
    };
    const script: MockScript = opts.script ?? DEFAULT_SCRIPT;

    const createAgent = async (
        def: AgentDefinition,
        createOpts: CreateOptions = {},
    ): Promise<AgentHandle> => {
        const agentId = createOpts.agentId ?? `mock-${randomUUID()}`;
        let turnIndex = 0;

        const send = async (
            msg: UserMessage,
            sendOpts: SendOptions = {},
        ): Promise<RunHandle> => {
            const prompt = typeof msg === 'string' ? msg : msg.text;
            const runId = sendOpts.runId ?? `mock-run-${randomUUID()}`;
            const currentTurn = turnIndex++;

            const events = script({
                def,
                prompt,
                turnIndex: currentTurn,
                runId,
            });

            return makeMockRunHandle(runId, events);
        };

        return { id: agentId, send };
    };

    const listModels = async (): Promise<ModelInfo[]> => opts.models ?? [];

    const identify = async (): Promise<{
        authed: boolean;
        principal?: string;
    }> => opts.identifyAs ?? { authed: true };

    return {
        capabilities,
        createAgent,
        listModels,
        identify,
    };
}

function makeMockRunHandle(
    runId: string,
    events: HarnessEvent[] | AsyncIterable<HarnessEvent>,
): RunHandle {
    let status: RunStatus = 'running';
    const statusListeners = new Set<(s: RunStatus) => void>();
    const setStatus = (next: RunStatus): void => {
        if (status === next) return;
        status = next;
        for (const fn of statusListeners) fn(next);
    };

    const buffered: HarnessEvent[] = [];
    let drainPromise: Promise<void> | null = null;
    let drainDone = false;
    let canceled = false;

    const ensureDraining = (): Promise<void> => {
        if (drainPromise !== null) return drainPromise;
        drainPromise = (async () => {
            try {
                if (Array.isArray(events)) {
                    for (const ev of events) {
                        if (canceled) break;
                        buffered.push(ev);
                        if (ev.kind === 'status') setStatus(ev.status);
                    }
                } else {
                    for await (const ev of events) {
                        if (canceled) break;
                        buffered.push(ev);
                        if (ev.kind === 'status') setStatus(ev.status);
                    }
                }
            } finally {
                drainDone = true;
                // If nothing terminal fired, infer `completed`.
                if (
                    !canceled &&
                    status === 'running' &&
                    !buffered.some(
                        (e) =>
                            e.kind === 'status' &&
                            (e.status === 'completed' ||
                                e.status === 'errored' ||
                                e.status === 'canceled'),
                    )
                ) {
                    buffered.push({
                        kind: 'status',
                        status: 'completed',
                        runId,
                    });
                    setStatus('completed');
                }
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
        let inputTokens = 0;
        let outputTokens = 0;
        let costUsd: number | undefined;
        let finalAssistant;
        let errorMessage: string | undefined;
        for (const ev of buffered) {
            if (ev.kind === 'assistant_message') finalAssistant = ev.content;
            else if (ev.kind === 'usage') {
                inputTokens = ev.inputTokens;
                outputTokens = ev.outputTokens;
                if (typeof ev.costUsd === 'number') costUsd = ev.costUsd;
            } else if (ev.kind === 'error') errorMessage = ev.message;
        }
        const terminal: RunResult['status'] =
            status === 'canceled'
                ? 'canceled'
                : status === 'errored'
                    ? 'errored'
                    : 'completed';
        const result: RunResult = {
            runId,
            status: terminal,
            finalAssistant,
            usage: { inputTokens, outputTokens, costUsd },
            durationMs,
        };
        if (errorMessage) result.error = { message: errorMessage };
        return result;
    };

    const cancel = async (): Promise<void> => {
        canceled = true;
        buffered.push({ kind: 'status', status: 'canceled', runId });
        setStatus('canceled');
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
        onStatusChange,
    };
}
