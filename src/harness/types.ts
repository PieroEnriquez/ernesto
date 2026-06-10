/**
 * Harness — canonical types for any agent-execution backend.
 *
 * This file is the contract from
 * `agent-ops://harness-abstraction/interface.md`. Every type below is
 * pure data (no runtime); concrete implementations
 * (`harness/cas`, `harness/mock`, future `harness/cursor`,
 * `harness/fragua`) re-export only their constructor.
 *
 * The full canonical taxonomy lives here regardless of whether the
 * first implementation (CAS) emits every variant — subset-emit is
 * forwards-compatible, supersetting later is not.
 */

/** Permissive JSON schema alias. Concrete validation is the harness's
 *  responsibility — the lib only needs to thread the schema through. */
export type JsonSchema = Record<string, unknown>;

/** Opaque model identifier per harness. There is no cross-harness
 *  canonical id; `harness.listModels()` is the only discovery surface. */
export interface ModelRef {
    id: string;
    params?: Record<string, unknown>;
}

/** Tool exposure shape. `fn` tools require `capabilities.customFnTools`;
 *  `mcp` tools require `capabilities.mcp`. */
export type ToolSpec =
    | { kind: 'builtin'; name: string }
    | { kind: 'mcp'; serverName: string }
    | {
          kind: 'fn';
          name: string;
          description: string;
          schema: JsonSchema;
          handler: (input: unknown) => Promise<unknown>;
      };

/** Subagent declaration (Task-style invocation from parent agent). */
export interface SubagentDef {
    slug: string;
    description: string;
    systemPrompt?: string;
    model?: ModelRef | string;
    tools?: ToolSpec[];
}

/** System prompt configuration — mirrors managed-agents'
 *  `SystemPromptConfig` for structural compatibility. */
export type SystemPromptConfig = string | { type: 'preset'; preset: 'claude_code'; append?: string };

/** Self-contained JSON schema output enforcement. */
export interface JsonSchemaOutputFormat {
    type: 'json_schema';
    name?: string;
    schema: Record<string, unknown>;
}

/**
 * Harness-agnostic agent declaration. `CompiledAgent`
 * (`managed-agents/types.ts`) structurally satisfies this — the
 * `model: string | ModelRef` widening accepts the existing string
 * shape, and the CAS adapter coerces `string` → `{ id: string }`
 * on the way to SDK options.
 */
export interface AgentDefinition {
    systemPrompt: SystemPromptConfig;
    model: string | ModelRef;
    /** Tools to expose. May be omitted; the harness defaults apply. */
    tools?: ToolSpec[];
    subagents?: SubagentDef[];
    maxTurns?: number;
    outputFormat?: JsonSchemaOutputFormat;
    disallowedTools?: string[];
    /** Backend-specific MCP server ids. The CAS adapter resolves these
     *  through a backend-private registry; other harnesses ignore. */
    mcpServers?: string[];
}

/** Static, harness-wide capability declaration. Frontends read this to
 *  gate UI affordances (steer, HITL, pause, etc.). See
 *  `agent-ops://harness-abstraction/capabilities.md`. */
export interface HarnessCapabilities {
    perTokenDeltas: boolean;
    steer: boolean;
    pause: boolean;
    hitl: boolean;
    subagents: boolean;
    customFnTools: boolean;
    mcp: boolean;
    multiProvider: boolean;
    listMessages: boolean;
    listAgents: boolean;
    resume: boolean;
    attachments: boolean;
    costReporting: boolean;
    midResponseCancel: boolean;
    nativeStructuredOutput: boolean;
}

/** User-side message: plain string or attachment-bearing object.
 *  Attachments require `capabilities.attachments`. */
export type UserMessage = string | { text: string; attachments?: AttachmentRef[] };

/** Opaque attachment reference — concrete shape is harness-defined. */
export interface AttachmentRef {
    kind: 'image' | 'file';
    /** Either a URI (`file://`, `https://`, `data:`) or an opaque id. */
    ref: string;
    mimeType?: string;
}

/** Assistant content block — text, tool use, or thinking. Mirrors
 *  Anthropic's structural superset; other backends collapse into it. */
export type AssistantBlock =
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
    | { type: 'thinking'; text: string };

/** User content block for replay (text + optional tool results). */
export type UserBlock =
    | { type: 'text'; text: string }
    | {
          type: 'tool_result';
          toolUseId: string;
          output: unknown;
          isError: boolean;
      };

/** Run lifecycle status. Transitions: `running` → terminal
 *  (`completed` | `errored` | `canceled`) or `paused` ↔ `running`. */
export type RunStatus = 'running' | 'completed' | 'errored' | 'canceled' | 'paused';

/** Canonical run-time event. Consumers handle unknown variants by
 *  ignoring rather than throwing — variants are added forwards. */
export type HarnessEvent =
    | { kind: 'assistant_delta'; text: string; runId: string }
    | { kind: 'assistant_message'; content: AssistantBlock[]; runId: string }
    | {
          kind: 'tool_call';
          toolUseId: string;
          name: string;
          input: unknown;
          runId: string;
      }
    | {
          kind: 'tool_result';
          toolUseId: string;
          output: unknown;
          isError: boolean;
          runId: string;
      }
    | { kind: 'thinking'; text: string; runId: string }
    | { kind: 'status'; status: RunStatus; runId: string }
    | {
          kind: 'usage';
          inputTokens: number;
          outputTokens: number;
          cacheRead?: number;
          cacheWrite?: number;
          costUsd?: number;
          runId: string;
      }
    | {
          kind: 'subagent_started';
          slug: string;
          subRunId: string;
          parentRunId: string;
      }
    | {
          kind: 'subagent_completed';
          slug: string;
          subRunId: string;
          parentRunId: string;
          result: unknown;
      }
    | {
          kind: 'hitl_requested';
          promptId: string;
          schema?: unknown;
          runId: string;
      }
    | { kind: 'error'; message: string; recoverable: boolean; runId: string }
    // A UI component the agent emitted (e.g. via a `ui` tool). Carried as
    // `unknown` to keep harness types decoupled from `components`; the
    // backend casts it to a UiComponent when emitting `fact.component`.
    // Used by out-of-process runtimes (remote-vm) to bridge in-VM `ui`
    // calls back to the host's component bus → per-transport renderers.
    | { kind: 'component'; component: unknown; runId: string };

/** Canonical conversation-replay shape. */
export type HarnessMessage =
    | { role: 'user'; content: string | UserBlock[]; ts: number }
    | { role: 'assistant'; content: AssistantBlock[]; ts: number }
    | {
          role: 'tool';
          toolUseId: string;
          output: unknown;
          isError: boolean;
          ts: number;
      };

/** Terminal-state result of a run. */
export interface RunResult {
    runId: string;
    status: 'completed' | 'errored' | 'canceled';
    finalAssistant?: AssistantBlock[];
    /** When `AgentDefinition.outputFormat` is set + native enforcement
     *  succeeded. */
    structuredOutput?: unknown;
    usage: { inputTokens: number; outputTokens: number; costUsd?: number };
    durationMs: number;
    /** SDK-reported wire time excluding client-side wait. CAS:
     *  `SDKResultMessage.duration_api_ms`. */
    apiDurationMs?: number;
    /** Per-model usage breakdown for multi-model runs. CAS:
     *  `SDKResultMessage.modelUsage`. */
    modelUsage?: Record<string, { inputTokens: number; outputTokens: number; costUsd?: number }>;
    /** Backend-native subtype tag — CAS: `success`/`error_*`/`cancelled`;
     *  fragua: terminal reason. Opaque per harness. */
    subtype?: string;
    /** Backend-preferred raw result text. CAS:
     *  `SDKResultMessage.result`. Avoids the lossy scrape from
     *  `finalAssistant`. */
    rawText?: string;
    /** The Agent SDK's conversation transcript id (its `session_id`).
     *  CAS: the SDK's auto-generated UUID (also the filename under
     *  `~/.claude/projects/<cwd-enc>/<transcriptId>.jsonl`). Callers
     *  capture this to resume the same conversation on a later turn by
     *  passing it as `CreateOptions.resumeTranscript`. */
    transcriptId?: string;
    error?: { message: string; cause?: unknown };
}

/** Options accepted by `Harness.createAgent`. */
export interface CreateOptions {
    /** Caller-supplied stable id; harnesses may ignore and assign their
     *  own when this clashes with their persistence model. */
    agentId?: string;
    /** Working directory bound to this agent's runs. */
    cwd?: string;
    /** Per-run environment merged on top of harness defaults. */
    env?: Record<string, string>;
    /** Caller-controlled abort signal for the entire agent lifetime. */
    abortController?: AbortController;
    /** Persist the Agent SDK's conversation transcript (its
     *  `session_id`) — backend-defined (CAS: SDK transcript id,
     *  fragua: durable event log). */
    persistTranscript?: boolean;
    /** Resume a prior transcript by id — the Agent SDK's conversation
     *  transcript id (its `session_id`). Capability-gated (`resume`). */
    resumeTranscript?: string;
    /** Fork from `resumeTranscript` instead of continuing it. */
    forkTranscript?: boolean;
    /** Per-call MCP servers — merged on top of the harness env's
     *  defaults (call-level entries win on key collision). Lets each
     *  workflow run hand the harness conversation-scoped tool surfaces
     *  (e.g. the in-process transport's `ernesto` MCP closing over the run's workdir +
     *  user + scopes) without rebuilding the harness. */
    mcpServers?: Record<string, unknown>;
    /** Host-resolved sandbox hooks (e.g. the workspace-anchored
     *  PreToolUse path-guard). Opaque to the lib — passed straight
     *  through to the SDK's `Options.hooks`. Per-call because the guard
     *  closes over this run's workdir; the in-process transport sets it
     *  from the sandbox-bind middleware. A harness that ignores hooks
     *  (e.g. a non-SDK backend) simply drops it. */
    hooks?: unknown;
}

/** Options accepted by `AgentHandle.send`. */
export interface SendOptions {
    /** Caller-controlled abort for this specific run. */
    abortController?: AbortController;
    /** Caller-supplied run id; otherwise harness-assigned. */
    runId?: string;
}

/** Options accepted by `Harness.listAgents`. */
export interface ListOptions {
    limit?: number;
    cursor?: string;
}

/** Paginated list response. */
export interface ListResult<T> {
    items: T[];
    nextCursor?: string;
}

/** Surface-level metadata about a known agent. */
export interface AgentInfo {
    id: string;
    /** Last-modified time, ms since epoch. */
    lastActive?: number;
    /** Human-readable summary if the backend offers one. */
    summary?: string;
}

/** Model directory entry. `id` is the value to put into `ModelRef.id`. */
export interface ModelInfo {
    id: string;
    /** Human-readable label for UI. */
    name?: string;
    /** Free-form provider hint (`anthropic`, `openai`, `cursor`, etc.). */
    provider?: string;
    /** Context window in tokens, when known. */
    contextWindow?: number;
}

/** Live handle to a run. Capability-gated methods (`steer`, `pause`,
 *  `resume`, `respondToHitl`) are undefined when not supported. */
export interface RunHandle {
    readonly id: string;
    readonly status: RunStatus;
    /** Canonical event stream. Iterating walks the underlying
     *  backend stream lazily. */
    stream(): AsyncIterable<HarnessEvent>;
    /** Resolve to terminal state, including final assistant message
     *  and usage. */
    wait(): Promise<RunResult>;
    /** Cooperative cancel — supported by every harness. */
    cancel(): Promise<void>;
    /** Mid-run steering. Gated by `capabilities.steer`. */
    steer?(text: string): Promise<void>;
    /** Pause an in-flight run. Gated by `capabilities.pause`. */
    pause?(): Promise<void>;
    /** Resume a paused run. Gated by `capabilities.pause`. */
    resume?(): Promise<void>;
    /** Respond to a HITL prompt. Gated by `capabilities.hitl`. */
    respondToHitl?(input: unknown): Promise<void>;
    /** Status observer — fires on every transition. Returns disposer. */
    onStatusChange(fn: (s: RunStatus) => void): () => void;
}

/** Live handle to a created agent. */
export interface AgentHandle {
    readonly id: string;
    /** Send a user turn; returns a `RunHandle` that streams events
     *  until the LLM stops, the agent halts, or `cancel()` is called. */
    send(msg: UserMessage, opts?: SendOptions): Promise<RunHandle>;
    /** Tear down this agent's backend resources — release a microVM,
     *  close a transcript. Optional: harnesses with no external resource to
     *  free omit it. Distinct from `RunHandle.cancel()` (a per-turn
     *  interrupt that keeps the agent warm for resume); `stop()` ends the
     *  agent. Each harness registers its own teardown, so a
     *  renderer-initiated stop (→ `runner.abortRun` → the run's abort
     *  signal) reaches all the way down to e.g. `SandboxClient.stop`. */
    stop?(): Promise<void>;
    /** Replay-by-query of the agent's transcript. Gated by
     *  `capabilities.listMessages`. */
    getMessages?(): Promise<HarnessMessage[]>;
}

/** The runtime abstraction. All harnesses implement this shape. */
export interface Harness {
    /** Static capabilities — frontend reads this to gate UI. */
    readonly capabilities: HarnessCapabilities;
    /** Compile a declaration into a live agent. Idempotent across
     *  calls with the same input; returns a fresh handle each time. */
    createAgent(def: AgentDefinition, opts?: CreateOptions): Promise<AgentHandle>;
    /** Re-attach to a previously created agent by id.
     *  Gated by `capabilities.resume`. */
    resumeAgent?(agentId: string): Promise<AgentHandle>;
    /** List recent agents. Gated by `capabilities.listAgents`. */
    listAgents?(opts?: ListOptions): Promise<ListResult<AgentInfo>>;
    /** Models exposed by this harness. Opaque ids per backend. */
    listModels(): Promise<ModelInfo[]>;
    /** Auth + principal probe. Frontend uses to decide credential prompts. */
    identify(): Promise<{ authed: boolean; principal?: string }>;
}
