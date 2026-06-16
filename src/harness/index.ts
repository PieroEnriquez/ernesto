/**
 * Harness — canonical type barrel.
 *
 * Type-only re-exports so consumers can `import type { ... } from
 * 'ernesto/harness'` without pulling any backend SDK code. Concrete
 * implementations live behind sub-exports:
 *
 * - `ernesto/harness/cas` — Claude Agent SDK adapter (requires the
 *   optional `@anthropic-ai/claude-agent-sdk` peer dep).
 * - `ernesto/harness/mock` — script-driven mock for tests.
 */

export type {
    Harness,
    AgentHandle,
    RunHandle,
    HarnessEvent,
    HarnessCapabilities,
    AgentDefinition,
    ModelRef,
    ToolSpec,
    SubagentDef,
    RunResult,
    RunStatus,
    HarnessMessage,
    UserMessage,
    UserBlock,
    AssistantBlock,
    AttachmentRef,
    CreateOptions,
    SendOptions,
    ListOptions,
    ListResult,
    AgentInfo,
    ModelInfo,
    JsonSchema,
    JsonSchemaOutputFormat,
    SystemPromptConfig,
} from './types';
