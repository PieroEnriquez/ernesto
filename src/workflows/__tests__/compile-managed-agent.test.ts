/**
 * Compile a `ManagedAgentMd` → `WorkflowDeclaration`.
 *
 * Mechanical fixture-driven coverage.
 */

import { describe, it, expect } from 'vitest';
import { parseManagedAgentMd } from '../../managed-agents/from-md';
import { compileManagedAgentMdToWorkflow } from '../compile-managed-agent';

const PAYMENTS_AGENT = `---
slug: payments-analyst
name: Payments Analyst
description: Investigate payments anomalies for a given product.
model: claude-opus-4-7
maxTurns: 12
mcpServers: [redshift, ernesto]
callableAs: [subagent]
scope: [payments:read, redshift:query]
outputFormat:
  type: json_schema
  name: payments_report
  schema:
    type: object
    properties:
      product: { type: string }
      anomalies: { type: array, items: { type: object } }
    required: [product, anomalies]
disallowedTools: [WebFetch, Task]
---

You are the Payments Analyst. Given the user's request:

1. Read the relevant Redshift schema.
2. Run queries against the orders + refunds tables.
3. Summarize anomalies in the requested output format.
`;

describe('compileManagedAgentMdToWorkflow', () => {
    it('compiles the canonical payments-analyst fixture', () => {
        const md = parseManagedAgentMd(PAYMENTS_AGENT, {
            slug: 'payments-analyst',
            workspace: 'payments',
        });
        const wf = compileManagedAgentMdToWorkflow(md);

        expect(wf.name).toBe('payments-analyst');
        expect(wf.description).toBe(
            'Investigate payments anomalies for a given product.',
        );
        expect(wf.version).toBe(1);
        expect(wf.tags).toEqual(['managed-agent']);
        expect(wf.scope).toEqual(['payments:read', 'redshift:query']);
        expect(wf.callableAs).toEqual(['subagent']);
        expect(wf.inputs?.prompt?.type).toBe('string');
        expect(wf.outputs?.result?.from).toBe('main');

        const main = wf.steps.main;
        expect(main.kind).toBe('agent-cas');
        if (main.kind === 'agent-cas') {
            expect(main.model).toBe('claude-opus-4-7');
            expect(main.maxTurns).toBe(12);
            expect(main.mcpServers).toEqual(['redshift', 'ernesto']);
            expect(main.disallowedTools).toEqual(['WebFetch', 'Task']);
            expect(main.outputFormat?.name).toBe('payments_report');
            expect(main.prompt).toBe('{{ inputs.prompt }}');
            expect(main.next).toBe('outputs.result');
            expect(typeof main.systemPrompt).toBe('string');
            expect(main.systemPrompt as string).toMatch(/Payments Analyst/);
        }
    });

    it('is deterministic across two compiles of the same MD', () => {
        const md = parseManagedAgentMd(PAYMENTS_AGENT, {
            slug: 'payments-analyst',
            workspace: 'payments',
        });
        const a = compileManagedAgentMdToWorkflow(md);
        const b = compileManagedAgentMdToWorkflow(md);
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    });

    it('omits scope/callableAs when absent on the source MD', () => {
        const minimal = `---
slug: minimal
name: Minimal
description: A minimal agent.
model: claude-haiku-4-5
maxTurns: 1
---

Be terse.
`;
        const md = parseManagedAgentMd(minimal, {
            slug: 'minimal',
            workspace: 'qa',
        });
        const wf = compileManagedAgentMdToWorkflow(md);
        expect(wf.scope).toBeUndefined();
        expect(wf.callableAs).toBeUndefined();
        const main = wf.steps.main;
        expect(main.kind).toBe('agent-cas');
        if (main.kind === 'agent-cas') {
            expect(main.disallowedTools).toBeUndefined();
            expect(main.outputFormat).toBeUndefined();
        }
    });

    it('maps provider: OPEN_ROUTER → kind: agent-fragua-pi with providerOverride', () => {
        const openRouter = `---
slug: openrouter-bot
name: Openrouter Bot
description: An OpenRouter-backed managed agent.
provider: OPEN_ROUTER
model: anthropic/claude-3.5-sonnet
maxTurns: 4
---

Be helpful.
`;
        const md = parseManagedAgentMd(openRouter, {
            slug: 'openrouter-bot',
            workspace: 'qa',
        });
        const wf = compileManagedAgentMdToWorkflow(md);
        const main = wf.steps.main;
        expect(main.kind).toBe('agent-fragua-pi');
        if (main.kind === 'agent-fragua-pi') {
            expect(main.providerOverride).toBe('openrouter');
            expect(main.model).toBe('anthropic/claude-3.5-sonnet');
            expect(main.maxTurns).toBe(4);
            expect(main.prompt).toBe('{{ inputs.prompt }}');
            expect(main.next).toBe('outputs.result');
        }
    });

    it('maps provider: ANTHROPIC → kind: agent-cas (explicit)', () => {
        const anthropic = `---
slug: anthropic-bot
name: Anthropic Bot
description: An ANTHROPIC-backed managed agent.
provider: ANTHROPIC
model: claude-opus-4-7
maxTurns: 4
---

Be terse.
`;
        const md = parseManagedAgentMd(anthropic, {
            slug: 'anthropic-bot',
            workspace: 'qa',
        });
        const wf = compileManagedAgentMdToWorkflow(md);
        expect(wf.steps.main.kind).toBe('agent-cas');
    });
});
