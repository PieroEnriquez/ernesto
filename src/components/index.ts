/**
 * Component layer — declarative UI intent emitted by agents and route
 * steps, rendered by per-tier subscribers in their native UI.
 *
 * See `agent-ops://workflows-unification/components.md` for the design
 * doc (taxonomy + per-tier render table + emission flow).
 */

export {
    COMPONENT_KINDS,
    isComponent,
    isInputComponent,
} from './types';

export type {
    Component,
    ComponentKind,
    InputComponent,
    StatusProps,
    TableProps,
    MetricProps,
    MarkdownProps,
    ImageProps,
    CodeProps,
    LinkProps,
    AttachmentProps,
    ProgressProps,
    ChoiceInputProps,
    TextInputProps,
    FormProps,
    ChartProps,
    TreeProps,
    TreeNode,
    ThinkingProps,
} from './types';
