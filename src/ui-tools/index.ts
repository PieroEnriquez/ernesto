/**
 * In-process MCP server exposing the unified `ui` tool. The agent
 * emits one tool — `ui(UiComponent | UiComponent[])` — and the engine
 * validates + dispatches per-component. See
 * `agent-ops://workflows-unification/components.md` for the component
 * taxonomy.
 */

export { createUiMcpServer, UI_TOOL_COUNT, UI_TOOL_NAMES } from './server';
export type { UiMcpServerConfig, UiMcpServerHandle, UiToolContextResolver, CreateUiMcpServerOpts } from './server';
export type { UiToolContext, UiToolResult, UiHitlPauser, AttachmentTransformer, AttachmentTransformResult } from './types';

// Unified dispatcher — single entry the MCP server registers.
export { handleUi } from './tool-handlers/ui';
export type { UiArgs, UiCallResult } from './tool-handlers/ui';

// Bundled-UI middleware — generic side-channel for tools that want to
// fold a UI emission into the same call as their primary action.
export { extractAndEmitBundledUi, withBundledUiField, bundledUiComponentSchema, bundledUiFieldSchema } from './bundled-ui';
export type { BundledUiContext, BundledUiResult } from './bundled-ui';
