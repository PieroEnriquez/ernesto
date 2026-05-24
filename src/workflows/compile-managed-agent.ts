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
import { resolveHarness } from '../managed-agents/resolve-harness';
import type {
    WorkflowDeclaration,
    AgentStep,
    WorkflowInput,
    WorkflowOutput,
    JsonSchemaOutputFormat,
    SystemPromptConfig,
} from './types';

export function compileManagedAgentMdToWorkflow(
    md: ManagedAgentMd,
): WorkflowDeclaration {
    // Re-use the existing field-projection: it already handles every
    // frontmatter quirk (provider, harness, outputFormat shape,
    // scope/callableAs strict typing, slug regex). The systemPrompt it
    // composes IS the body-becomes-prompt rule we need for steps.main.
    const decl = toAgentDeclaration(md);

    // Single `kind: 'agent'` step; harness on the step preserves the
    // resolved declaration value (or its `provider:` shorthand) so
    // wire-fragua's agent handler dispatches to the right runtime
    // without re-reading the declaration.
    const harness = resolveHarness(decl);
    const mainStep: AgentStep = {
        kind: 'agent',
        harness,
        model: decl.model,
        systemPrompt: decl.systemPrompt as SystemPromptConfig,
        maxTurns: decl.maxTurns,
        mcpServers: decl.mcpServers,
        prompt: '{{ inputs.prompt }}',
        next: 'outputs.result',
        ...(harness === 'fragua-pi' && decl.provider === 'OPEN_ROUTER'
            ? { providerOverride: 'openrouter' as const }
            : {}),
    };
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
