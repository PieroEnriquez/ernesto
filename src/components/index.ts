/**
 * Component layer — declarative UI intent emitted by agents and route
 * steps, rendered by per-transport subscribers in their native UI.
 *
 * Two-level taxonomy:
 *   - {@link UiComponent} — top-level kinds the `ui` MCP tool accepts.
 *   - {@link RenderableComponent} — nested inside `hitl.props.render`.
 *
 * See `agent-ops://workflows-unification/components.md` for the design
 * doc (taxonomy + per-transport render table + emission flow).
 */

export {
    UI_COMPONENT_KINDS,
    RENDERABLE_COMPONENT_KINDS,
} from './types';

export type {
    // Top-level
    UiComponent,
    UiComponentKind,
    ThinkingComponent,
    StatusComponent,
    ProgressComponent,
    AttachmentComponent,
    HitlComponent,
    // Expect / next-step contract
    HitlExpect,
    NextStep,
    // Renderable
    RenderableComponent,
    RenderableComponentKind,
    // Renderable props
    MarkdownProps,
    DataRefProps,
    FileLinkProps,
    TableProps,
    TableColumn,
    TableRow,
    MetricProps,
    MetricDelta,
    ChartProps,
    CodeProps,
    ImageProps,
    LinkProps,
    TreeProps,
    TreeNode,
} from './types';

export {
    validateUiComponent,
    validateThinking,
    validateStatus,
    validateProgress,
    validateAttachment,
    validateHitl,
    validateRenderableComponent,
    collectUiComponentErrors,
} from './validation';

export type { ValidationResult } from './validation';

export { coerceUiComponent } from './coerce';
