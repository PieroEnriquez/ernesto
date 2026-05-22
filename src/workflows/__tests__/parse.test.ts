/**
 * Round-trip + error tests for `parseWorkflowYaml`.
 */

import { describe, it, expect } from 'vitest';
import { dump as yamlDump } from 'js-yaml';
import { parseWorkflowYaml } from '../parse';
import type { WorkflowDeclaration } from '../types';

const MINIMAL_YAML = `
name: hello
description: A one-step hello.
version: 1
steps:
  main:
    kind: agent-cas
    model: claude-haiku-4-5
    systemPrompt: |
      You say hello.
    prompt: "{{ inputs.prompt }}"
    next: outputs.result
inputs:
  prompt:
    type: string
outputs:
  result:
    from: main
`;

describe('parseWorkflowYaml', () => {
    it('parses a minimal one-step agent workflow', () => {
        const decl = parseWorkflowYaml(MINIMAL_YAML);
        expect(decl.name).toBe('hello');
        expect(decl.version).toBe(1);
        expect(Object.keys(decl.steps)).toEqual(['main']);
        const main = decl.steps.main;
        expect(main.kind).toBe('agent-cas');
        if (main.kind === 'agent-cas') {
            expect(main.model).toBe('claude-haiku-4-5');
            expect(main.prompt).toBe('{{ inputs.prompt }}');
            expect(main.next).toBe('outputs.result');
        }
        expect(decl.inputs?.prompt?.type).toBe('string');
        expect(decl.outputs?.result?.from).toBe('main');
    });

    it('round-trips through yaml.dump → parseWorkflowYaml unchanged on key fields', () => {
        const first = parseWorkflowYaml(MINIMAL_YAML);
        const reEmitted = yamlDump(first);
        const second = parseWorkflowYaml(reEmitted);
        // Names / shapes must match exactly after serialize→parse.
        expect(second.name).toBe(first.name);
        expect(second.description).toBe(first.description);
        expect(second.version).toBe(first.version);
        expect(Object.keys(second.steps)).toEqual(Object.keys(first.steps));
        expect(second.outputs).toEqual(first.outputs);
        expect(second.inputs).toEqual(first.inputs);
    });

    it('throws on malformed YAML with line/column info', () => {
        const broken = `
name: x
description: y
version: 1
steps:
  main:
    kind: route
    uri: "redshift://q
`;
        expect(() => parseWorkflowYaml(broken, { filename: 'broken.yaml' })).toThrow(
            /broken\.yaml: malformed YAML/,
        );
    });

    it('throws on empty YAML', () => {
        expect(() => parseWorkflowYaml('')).toThrow(/workflow YAML is empty/);
    });

    it('throws if the root is an array', () => {
        expect(() => parseWorkflowYaml('- a\n- b')).toThrow(/must be a mapping at the root/);
    });

    it('throws on unknown top-level key', () => {
        const bad = `name: x
description: y
version: 1
steps: { main: { kind: route, uri: r:// } }
extraKey: 42
`;
        expect(() => parseWorkflowYaml(bad)).toThrow(/unknown top-level key "extraKey"/);
    });

    it('throws when version is not 1', () => {
        const bad = `name: x
description: y
version: 2
steps: { main: { kind: route, uri: r:// } }
`;
        expect(() => parseWorkflowYaml(bad)).toThrow(/"version" must be the literal number 1/);
    });

    it('throws when steps is missing', () => {
        const bad = `name: x
description: y
version: 1
`;
        expect(() => parseWorkflowYaml(bad)).toThrow(/"steps" is required/);
    });

    it('parses route, input, agent, subworkflow step kinds', () => {
        const yaml = `name: multi
description: All step kinds.
version: 1
inputs:
  product: { type: string }
steps:
  collect:
    kind: input
    schema:
      type: object
      properties: { product: { type: string } }
      required: [product]
    prompt: pick one
    defaults:
      product: "\${{ inputs.product }}"
    skipIfProvided: true
    next: fetch
  fetch:
    kind: route
    uri: redshift://query
    params: { template: "select 1" }
    render: table
    next: analyze
  analyze:
    kind: agent-cas
    model: claude-opus-4-7
    systemPrompt: "You analyze."
    maxTurns: 8
    prompt: "look at {{ steps.fetch.output }}"
    next: review
  review:
    kind: subworkflow
    ref: reviewer
    inputs: { draft: "x" }
    next: outputs.result
outputs:
  result: { from: review }
`;
        const decl = parseWorkflowYaml(yaml);
        expect(decl.steps.collect.kind).toBe('input');
        expect(decl.steps.fetch.kind).toBe('route');
        expect(decl.steps.analyze.kind).toBe('agent-cas');
        expect(decl.steps.review.kind).toBe('subworkflow');
    });

    it('parses kind: agent-cursor', () => {
        const yaml = `name: cursor
description: cursor.
version: 1
steps:
  main:
    kind: agent-cursor
    model: gpt-5
    systemPrompt: "You are a Cursor agent."
    prompt: "{{ inputs.prompt }}"
    next: outputs.result
inputs: { prompt: { type: string } }
outputs: { result: { from: main } }
`;
        const decl = parseWorkflowYaml(yaml);
        expect(decl.steps.main.kind).toBe('agent-cursor');
        const main = decl.steps.main;
        if (main.kind === 'agent-cursor') {
            expect(main.model).toBe('gpt-5');
        }
    });

    it('parses kind: agent-fragua-pi with providerOverride', () => {
        const yaml = `name: fragua
description: fragua-pi step.
version: 1
steps:
  main:
    kind: agent-fragua-pi
    providerOverride: openrouter
    model: anthropic/claude-3.5-sonnet
    systemPrompt: "You are a Fragua agent."
    prompt: "{{ inputs.prompt }}"
    next: outputs.result
inputs: { prompt: { type: string } }
outputs: { result: { from: main } }
`;
        const decl = parseWorkflowYaml(yaml);
        const main = decl.steps.main;
        expect(main.kind).toBe('agent-fragua-pi');
        if (main.kind === 'agent-fragua-pi') {
            expect(main.providerOverride).toBe('openrouter');
            expect(main.model).toBe('anthropic/claude-3.5-sonnet');
        }
    });

    it('rejects a legacy "harness:" field on an agent step', () => {
        const yaml = `name: legacy
description: legacy.
version: 1
steps:
  main:
    kind: agent-cas
    harness: cas
    model: m
    systemPrompt: sys
    prompt: p
    next: outputs.r
outputs: { r: { from: main } }
`;
        expect(() => parseWorkflowYaml(yaml)).toThrow(/has a "harness:" field/);
    });

    it('rejects providerOverride on a non-fragua-pi agent step', () => {
        const yaml = `name: bad
description: bad.
version: 1
steps:
  main:
    kind: agent-cas
    providerOverride: openrouter
    model: m
    systemPrompt: sys
    prompt: p
    next: outputs.r
outputs: { r: { from: main } }
`;
        expect(() => parseWorkflowYaml(yaml)).toThrow(/providerOverride is only valid on kind: agent-fragua-pi/);
    });

    it('preserves the agent preset systemPrompt shape', () => {
        const yaml = `name: preset
description: preset.
version: 1
steps:
  main:
    kind: agent-cas
    model: m
    systemPrompt:
      type: preset
      preset: claude_code
      append: hello
    prompt: p
    next: outputs.r
outputs: { r: { from: main } }
`;
        const decl = parseWorkflowYaml(yaml);
        const m = decl.steps.main as Extract<WorkflowDeclaration['steps'][string], { kind: 'agent-cas' }>;
        expect(m.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'hello' });
    });
});
