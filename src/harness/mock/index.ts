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
    SendOptions,
    UserMessage,
} from '../types';
import { makeRunHandle } from '../run-handle';

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
export type MockScript = (input: MockScriptInput) => HarnessEvent[] | AsyncIterable<HarnessEvent>;

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

    const createAgent = async (def: AgentDefinition, createOpts: CreateOptions = {}): Promise<AgentHandle> => {
        const agentId = createOpts.agentId ?? `mock-${randomUUID()}`;
        let turnIndex = 0;

        const send = async (msg: UserMessage, sendOpts: SendOptions = {}): Promise<RunHandle> => {
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

function makeMockRunHandle(runId: string, events: HarnessEvent[] | AsyncIterable<HarnessEvent>): RunHandle {
    // The mock's "messages" are already canonical `HarnessEvent`s, so
    // `mapMessage` is identity. Arrays are adapted to an async iterable
    // so the single base drain path handles both script shapes.
    const source: AsyncIterable<HarnessEvent> = Array.isArray(events)
        ? (async function* () {
              for (const ev of events) yield ev;
          })()
        : events;

    return makeRunHandle<HarnessEvent>({
        runId,
        source,
        createState: () => null,
        mapMessage: (ev) => [ev],
        // Cooperative cancel: stop pushing further scripted events once
        // `cancel()` fires (matches the legacy `if (canceled) break`).
        stopOnCancel: true,
        // Mock has no provider to interrupt — cancel is pure bookkeeping
        // (the base appends `status: canceled` + flips the status cell).
        cancel: async () => {},
        // If the script never emitted a terminal status, infer
        // `completed` after a clean drain (skipped when canceled, since
        // the base already appended `status: canceled`).
        finalizeStream: (_state, lastStatus) => (lastStatus === 'running' ? [{ kind: 'status', status: 'completed', runId }] : []),
        // Mock surfaces no SDK-specific extras — the common fold is the
        // whole result.
        mapResult: (fold): RunResult => {
            const result: RunResult = {
                runId: fold.runId,
                status: fold.status,
                finalAssistant: fold.finalAssistant,
                usage: fold.usage,
                durationMs: fold.durationMs,
            };
            if (fold.errorMessage) {
                result.error = { message: fold.errorMessage };
            }
            return result;
        },
    });
}
