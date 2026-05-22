/**
 * Compile a managed-agent Markdown file (parsed via
 * `parseManagedAgentMd`) into a `WorkflowDeclaration`.
 *
 * The mapping is mechanical and one-way — see
 * `workspaces/agent-ops/workflows-unification/managed-agents-mapping.md`
 * § Compile rules.
 *
 *   - body                       → steps.main.systemPrompt
 *   - {{ inputs.prompt }}        → steps.main.prompt (user-turn)
 *   - inputs.prompt: {type:str}  → always injected
 *   - outputs.result: {from:main}→ always injected
 *
 * Compile is deterministic (same input → same WorkflowDeclaration).
 */

import type { ManagedAgentMd } from '../managed-agents/from-md';
import { toAgentDeclaration } from '../managed-agents/from-md';
import type {
    WorkflowDeclaration,
    AgentStep,
    AgentCasStep,
    AgentFraguaPiStep,
    WorkflowInput,
    WorkflowOutput,
    JsonSchemaOutputFormat,
    SystemPromptConfig,
} from './types';

export function compileManagedAgentMdToWorkflow(
    md: ManagedAgentMd,
): WorkflowDeclaration {
    // Re-use the existing field-projection: it already handles every
    // frontmatter quirk (provider, outputFormat shape, scope/callableAs
    // strict typing, slug regex). The systemPrompt it composes IS the
    // body-becomes-prompt rule we need for steps.main.
    const decl = toAgentDeclaration(md);

    // Map the managed-agent provider to a concrete agent-step kind:
    //   provider: ANTHROPIC | (absent)  → kind: agent-cas
    //   provider: OPEN_ROUTER           → kind: agent-fragua-pi + providerOverride: openrouter
    // There is no managed-agent shorthand for Cursor — authors who want
    // Cursor must graduate to a hand-written workflow YAML.
    const mainStep: AgentStep = decl.provider === 'OPEN_ROUTER'
        ? ({
            kind: 'agent-fragua-pi',
            providerOverride: 'openrouter',
            model: decl.model,
            systemPrompt: decl.systemPrompt as SystemPromptConfig,
            maxTurns: decl.maxTurns,
            mcpServers: decl.mcpServers,
            prompt: '{{ inputs.prompt }}',
            next: 'outputs.result',
        } as AgentFraguaPiStep)
        : ({
            kind: 'agent-cas',
            model: decl.model,
            systemPrompt: decl.systemPrompt as SystemPromptConfig,
            maxTurns: decl.maxTurns,
            mcpServers: decl.mcpServers,
            prompt: '{{ inputs.prompt }}',
            next: 'outputs.result',
        } as AgentCasStep);
    if (decl.outputFormat) {
        mainStep.outputFormat = decl.outputFormat as JsonSchemaOutputFormat;
    }
    if (decl.disallowedTools && decl.disallowedTools.length > 0) {
        mainStep.disallowedTools = decl.disallowedTools;
    }

    const inputs: Record<string, WorkflowInput> = {
        prompt: {
            type: 'string',
            description: "The user's request to the agent.",
        },
    };
    const outputs: Record<string, WorkflowOutput> = {
        result: { from: 'main' },
    };

    const workflow: WorkflowDeclaration = {
        name: decl.id,
        description: decl.description,
        version: 1,
        tags: ['managed-agent'],
        inputs,
        steps: { main: mainStep },
        outputs,
    };

    if (decl.scope && decl.scope.length > 0) {
        workflow.scope = decl.scope;
    }
    if (decl.callableAs && decl.callableAs.length > 0) {
        workflow.callableAs = decl.callableAs;
    }

    return workflow;
}
