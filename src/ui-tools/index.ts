/**
 * In-process MCP server exposing the 15 `ui.*` tools. See
 * `agent-ops://workflows-unification/components.md` § The `ui.*` tool
 * surface for the per-tool semantics + LLM-facing usage guidance.
 */

export {
    createUiMcpServer,
    createUiWorkspaceServer,
    UI_TOOL_COUNT,
    UI_TOOL_NAMES,
} from './server';
export type {
    UiMcpServerConfig,
    UiMcpServerHandle,
    UiToolContextResolver,
    CreateUiMcpServerOpts,
    UiWorkspaceServer,
} from './server';
export type { UiToolContext, UiToolResult, UiHitlPauser } from './types';

// Per-tool handler re-exports — useful for tests that want to drive
// a single handler directly without bringing up the MCP transport.
export { handleStatus } from './tool-handlers/status';
export { handleTable } from './tool-handlers/table';
export { handleMetric } from './tool-handlers/metric';
export { handleMarkdown } from './tool-handlers/markdown';
export { handleImage } from './tool-handlers/image';
export { handleCode } from './tool-handlers/code';
export { handleLink } from './tool-handlers/link';
export { handleAttachment } from './tool-handlers/attachment';
export { handleProgress } from './tool-handlers/progress';
export { handleChoiceInput } from './tool-handlers/choice-input';
export { handleTextInput } from './tool-handlers/text-input';
export { handleForm } from './tool-handlers/form';
export { handleChart } from './tool-handlers/chart';
export { handleTree } from './tool-handlers/tree';
export { handleThinking } from './tool-handlers/thinking';
