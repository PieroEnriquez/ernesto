/**
 * Cursor-specific agent-creation helper.
 *
 * Same pattern as `casCreateAgent`: a strongly-typed Cursor-only entry
 * point that lives alongside the narrow `Harness.createAgent(def, opts)`
 * surface, not on it. Backend wrappers that need Cursor-private context
 * (API key, sandbox toggle, native MCP servers, idempotency key) flow
 * through this helper; the `Harness` interface stays narrow.
 *
 * Lifecycle:
 *
 *   1. Compile `AgentDefinition` → Cursor `AgentOptions` via
 *      `compile.ts`. Fn-shaped tools are wrapped into synth HTTP MCP
 *      servers via `mcp-bridge.ts` first and merged into `mcpServers`.
 *   2. `Agent.create(options)` returns a live `SDKAgent`.
 *   3. `handle.send(prompt)` issues `agent.send(prompt, sendOptions)`
 *      and returns a canonical `RunHandle`.
 *   4. `handle.close()` shuts down both the Cursor agent and the
 *      synth MCP HTTP servers.
 *
 * The synth-MCP servers are bound to the agent's lifetime: closing the
 * agent closes them. This is the "fewest external processes per agent
 * run" rule from step 2 — one HTTP listener per fn tool, all
 * in-process, all torn down together.
 */

import { randomUUID } from 'crypto';
import { Agent } from '@cursor/sdk';
import type {
    AgentOptions,
    McpServerConfig,
    SendOptions as CursorSendOptions,
    SDKAgent,
    SDKMessage as CursorSDKMessage,
    SettingSource,
    InteractionUpdate,
} from '@cursor/sdk';
import type { AgentDefinition, AgentHandle, HarnessMessage, RunHandle, SendOptions, UserMessage } from '../types';
import { compileAgentToCursorOptions } from './compile';
import { wrapFnToolsAsMcpServers, type SynthMcpServerHandle } from './mcp-bridge';
import { cursorSend } from './send';

/** Strongly-typed Cursor create options. Superset of the canonical
 *  `CreateOptions`. */
export interface CursorCreateOptions {
    /** Stable id propagated as Cursor `AgentOptions.agentId`. */
    agentId?: string;
    /** Local working directory. */
    cwd?: string;
    /** Ambient setting sources Cursor should load (project/user/team/…).
     *  Defaults to `[]` (isolation). */
    settingSources?: SettingSource[];
    /** Sandbox toggle (Cursor's `local.sandboxOptions.enabled`). */
    sandboxEnabled?: boolean;
    /** Cursor API key; falls back to `process.env.CURSOR_API_KEY`. */
    apiKey?: string;
    /** Pre-resolved MCP server map (native Cursor MCP entries —
     *  stdio or http/sse configs). */
    mcpServers?: Record<string, McpServerConfig>;
    /** Caller-controlled idempotency. */
    idempotencyKey?: string;
    /** Cloud-agent options. When set, takes precedence over local cwd/
     *  settingSources/sandboxOptions. */
    cloud?: AgentOptions['cloud'];
    /** Caller-controlled abort for the entire agent lifetime. Not
     *  consumed by Cursor's `Agent.create` directly — propagates into
     *  the harness handle so `cancel()` can fire on signal abort. */
    abortController?: AbortController;
}

/** Per-send Cursor extensions on top of the canonical `SendOptions`. */
export interface CursorAgentSendOptions extends SendOptions {
    /** Pre-built Cursor `SendOptions` — model override, per-send MCP
     *  servers, etc. The harness composes its own `onDelta` on top
     *  (see `send.ts`); the caller's `onDelta` still fires via the
     *  forwarder chain. */
    cursorOptions?: CursorSendOptions;
    /** Tap each raw Cursor `SDKMessage` as it arrives. Mirrors
     *  `CasAgentSendOptions.onRawMessage`. */
    onRawMessage?: (msg: CursorSDKMessage) => void;
    /** Tap each `InteractionUpdate` from Cursor's `onDelta`. Useful
     *  for callers that want per-token UI updates without iterating
     *  `RunHandle.stream()`. */
    onDelta?: (update: InteractionUpdate) => void;
}

/** Cursor-typed agent handle. Structurally a canonical `AgentHandle`. */
export interface CursorAgentHandle extends AgentHandle {
    send(msg: UserMessage, opts?: CursorAgentSendOptions): Promise<RunHandle>;
    /** Cursor-only: shut down the underlying `SDKAgent` plus any synth
     *  MCP servers wrapping fn tools. */
    close(): Promise<void>;
    /** Cursor exposes `agent.messages.list` (sqlite-backed). Maps to
     *  the canonical `HarnessMessage[]` shape. */
    getMessages(): Promise<HarnessMessage[]>;
}

/**
 * Create a Cursor-backed `AgentHandle`. `Agent.create(options)` is
 * invoked exactly once here; each `agent.send(prompt)` reuses the same
 * `SDKAgent` instance. Synth MCP servers spin up once per fn tool and
 * live for the agent's lifetime.
 */
export async function cursorCreateAgent(def: AgentDefinition, opts: CursorCreateOptions = {}): Promise<CursorAgentHandle> {
    const agentId = opts.agentId ?? `cursor-${randomUUID()}`;

    // 1. Synthesize MCP servers for fn-shaped tools.
    const wrapped = await wrapFnToolsAsMcpServers(def.tools);
    const synthServers: SynthMcpServerHandle[] = wrapped.handles;

    // 2. Compile harness IR → Cursor `AgentOptions`.
    const cursorOptions = compileAgentToCursorOptions(def, {
        cwd: opts.cwd,
        settingSources: opts.settingSources,
        sandboxEnabled: opts.sandboxEnabled,
        apiKey: opts.apiKey,
        nativeMcpServers: opts.mcpServers,
        synthMcpServers: wrapped.mcpServers,
        agentId,
        idempotencyKey: opts.idempotencyKey,
        cloud: opts.cloud,
    });

    // 3. Create the live Cursor agent.
    const sdkAgent: SDKAgent = await Agent.create(cursorOptions);

    // 4. Plumb cancel propagation. Cursor `Agent.create` doesn't
    //    accept an AbortController; we attach a signal listener that
    //    closes the agent + synth servers on abort.
    let aborted = false;
    if (opts.abortController) {
        const onAbort = (): void => {
            if (aborted) return;
            aborted = true;
            // Fire-and-forget; the underlying agent may already be
            // mid-disposal.
            void sdkAgent.close();
            void wrapped.closeAll();
        };
        if (opts.abortController.signal.aborted) {
            onAbort();
        } else {
            opts.abortController.signal.addEventListener('abort', onAbort, {
                once: true,
            });
        }
    }

    const send = async (msg: UserMessage, sendOpts: CursorAgentSendOptions = {}): Promise<RunHandle> => {
        const prompt = typeof msg === 'string' ? msg : msg.text;
        const runId = sendOpts.runId ?? `run-${randomUUID()}`;
        return cursorSend({
            agent: sdkAgent,
            prompt,
            runId,
            cursorOptions: sendOpts.cursorOptions,
            onRawMessage: sendOpts.onRawMessage,
            onDelta: sendOpts.onDelta,
        });
    };

    const close = async (): Promise<void> => {
        try {
            sdkAgent.close();
        } catch (err) {
            // `close()` is sync in the SDK, but defensively wrapped.
            void err;
        }
        await wrapped.closeAll();
        void synthServers;
    };

    const getMessages = async (): Promise<HarnessMessage[]> => {
        // Cursor's `Agent.messages.list(agentId)` returns
        // `AgentMessage[]` with `type: 'user' | 'assistant'`. The
        // shape inside `message` is opaque per the SDK's type
        // (`unknown`); we collapse to canonical text-only entries
        // and let CAS-aware-callers reach for the raw shape via
        // their own SDK import.
        const raw = await Agent.messages.list(agentId, {
            ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        });
        const out: HarnessMessage[] = [];
        for (const m of raw) {
            const ts = Date.now();
            if (m.type === 'user') {
                const text = extractText(m.message);
                out.push({ role: 'user', content: text, ts });
            } else if (m.type === 'assistant') {
                const text = extractText(m.message);
                out.push({
                    role: 'assistant',
                    content: [{ type: 'text', text }],
                    ts,
                });
            }
        }
        return out;
    };

    return {
        id: agentId,
        send,
        close,
        getMessages,
    };
}

/** Best-effort text extraction from Cursor's opaque message payload.
 *  Cursor's `AgentMessage.message` is typed as `unknown`; we look for
 *  common shapes and otherwise JSON-stringify so consumers don't lose
 *  data outright. */
function extractText(message: unknown): string {
    if (typeof message === 'string') return message;
    if (message && typeof message === 'object') {
        const m = message as { text?: unknown; content?: unknown };
        if (typeof m.text === 'string') return m.text;
        if (Array.isArray(m.content)) {
            const parts: string[] = [];
            for (const c of m.content) {
                const cc = c as { type?: string; text?: string };
                if (cc.type === 'text' && typeof cc.text === 'string') {
                    parts.push(cc.text);
                }
            }
            if (parts.length > 0) return parts.join('');
        }
    }
    try {
        return JSON.stringify(message);
    } catch {
        return String(message);
    }
}
