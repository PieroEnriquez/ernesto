/**
 * Unified workflow module — declaration types, parser, compilers from
 * the two legacy shapes (managed-agents, dashboards), and the
 * settle-time validator that produces the `workflow_*` lint codes.
 *
 * Pure data; no runtime dependencies beyond `js-yaml` and the existing
 * `managed-agents` + `dashboards` modules.
 */

export { parseWorkflowYaml } from './parse';
export type { ParseWorkflowOptions } from './parse';

export { compileManagedAgentMdToWorkflow } from './compile-managed-agent';
export { compileDashboardSpecToWorkflow } from './compile-dashboard';

export { validateWorkflow } from './validate';
export type { WorkflowValidateContext } from './validate';

export { isAgentStep } from './types';
export type {
    WorkflowDeclaration,
    WorkflowStep,
    BaseStep,
    RouteStep,
    InputStep,
    AgentStep,
    AgentHarness,
    GroupStep,
    WorkflowInput,
    WorkflowOutput,
    StepKind,
    WorkflowValidationResult,
    WorkflowValidationError,
    WorkflowLintCode,
    SystemPromptConfig,
    JsonSchemaOutputFormat,
} from './types';
