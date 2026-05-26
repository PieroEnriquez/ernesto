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
    kind: agent
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
    it('parses a minimal one-step agent workflow (inline form)', () => {
        const decl = parseWorkflowYaml(MINIMAL_YAML);
        expect(decl.name).toBe('hello');
        expect(decl.version).toBe(1);
        expect(Object.keys(decl.steps)).toEqual(['main']);
        const main = decl.steps.main;
        expect(main.kind).toBe('agent');
        if (main.kind === 'agent') {
            expect(main.model).toBe('claude-haiku-4-5');
            expect(main.prompt).toBe('{{ inputs.prompt }}');
            expect(main.next).toBe('outputs.result');
            // No explicit harness on the step — wire-fragua defaults to cas.
            expect(main.harness).toBeUndefined();
        }
        expect(decl.inputs?.prompt?.type).toBe('string');
        expect(decl.outputs?.result?.from).toBe('main');
    });

    it('parses a ref-form agent step', () => {
        const yaml = `name: ref
description: reference-form agent.
version: 1
steps:
  main:
    kind: agent
    ref: investigator
    prompt: "Investigate {{ inputs.date }}"
    next: outputs.r
inputs: { date: { type: string } }
outputs: { r: { from: main } }
`;
        const decl = parseWorkflowYaml(yaml);
        const main = decl.steps.main;
        expect(main.kind).toBe('agent');
        if (main.kind === 'agent') {
            expect(main.ref).toBe('investigator');
            expect(main.prompt).toBe('Investigate {{ inputs.date }}');
            expect(main.model).toBeUndefined();
            expect(main.systemPrompt).toBeUndefined();
        }
    });

    it('round-trips through yaml.dump → parseWorkflowYaml unchanged on key fields', () => {
        const first = parseWorkflowYaml(MINIMAL_YAML);
        const reEmitted = yamlDump(first);
        const second = parseWorkflowYaml(reEmitted);
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
    kind: agent
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
        expect(decl.steps.analyze.kind).toBe('agent');
        expect(decl.steps.review.kind).toBe('subworkflow');
    });

    it('parses an agent step with harness: cursor', () => {
        const yaml = `name: cursor
description: cursor.
version: 1
steps:
  main:
    kind: agent
    harness: cursor
    model: gpt-5
    systemPrompt: "You are a Cursor agent."
    prompt: "{{ inputs.prompt }}"
    next: outputs.result
inputs: { prompt: { type: string } }
outputs: { result: { from: main } }
`;
        const decl = parseWorkflowYaml(yaml);
        const main = decl.steps.main;
        expect(main.kind).toBe('agent');
        if (main.kind === 'agent') {
            expect(main.harness).toBe('cursor');
            expect(main.model).toBe('gpt-5');
        }
    });

    it('parses an agent step with harness: fragua-pi + providerOverride', () => {
        const yaml = `name: fragua
description: fragua-pi step.
version: 1
steps:
  main:
    kind: agent
    harness: fragua-pi
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
        expect(main.kind).toBe('agent');
        if (main.kind === 'agent') {
            expect(main.harness).toBe('fragua-pi');
            expect(main.providerOverride).toBe('openrouter');
            expect(main.model).toBe('anthropic/claude-3.5-sonnet');
        }
    });

    it('rejects providerOverride when harness is pinned to a non-fragua-pi value', () => {
        const yaml = `name: bad
description: bad.
version: 1
steps:
  main:
    kind: agent
    harness: cas
    providerOverride: openrouter
    model: m
    systemPrompt: sys
    prompt: p
    next: outputs.r
outputs: { r: { from: main } }
`;
        expect(() => parseWorkflowYaml(yaml)).toThrow(/providerOverride is only valid when harness resolves to "fragua-pi"/);
    });

    it('rejects an inline agent step missing model', () => {
        const yaml = `name: bad
description: bad.
version: 1
steps:
  main:
    kind: agent
    systemPrompt: sys
    prompt: p
    next: outputs.r
outputs: { r: { from: main } }
`;
        expect(() => parseWorkflowYaml(yaml)).toThrow(/must declare either "ref" or inline "model"/);
    });

    it('rejects an unknown harness value', () => {
        const yaml = `name: bad
description: bad.
version: 1
steps:
  main:
    kind: agent
    harness: claude
    model: m
    systemPrompt: sys
    prompt: p
    next: outputs.r
outputs: { r: { from: main } }
`;
        expect(() => parseWorkflowYaml(yaml)).toThrow(/harness must be "cas" \| "cursor" \| "fragua-pi"/);
    });

    it('preserves the agent preset systemPrompt shape', () => {
        const yaml = `name: preset
description: preset.
version: 1
steps:
  main:
    kind: agent
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
        const m = decl.steps.main as Extract<WorkflowDeclaration['steps'][string], { kind: 'agent' }>;
        expect(m.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'hello' });
    });

    it('parses kind: group with nested sub-DAG steps + concurrency', () => {
        const yaml = `name: grp
description: group test.
version: 1
steps:
  fan:
    kind: group
    concurrency: 2
    steps:
      a: { kind: route, uri: x://a }
      b: { kind: route, uri: x://b, depends: [a] }
    outputs: { r: { from: "\${{ steps.a.outputs }}" } }
outputs: { r: { from: fan } }
`;
        const decl = parseWorkflowYaml(yaml);
        const fan = decl.steps.fan;
        expect(fan.kind).toBe('group');
        if (fan.kind === 'group') {
            expect(Object.keys(fan.steps)).toEqual(['a', 'b']);
            expect(fan.steps.a.kind).toBe('route');
            expect(fan.steps.b.depends).toEqual(['a']);
            expect(fan.concurrency).toBe(2);
            expect(fan.outputs).toBeDefined();
        }
    });

    it('parses depends / skipIf / fallback on a step', () => {
        const yaml = `name: dag
description: dag test.
version: 1
steps:
  first: { kind: route, uri: x://a }
  second:
    kind: route
    uri: x://b
    depends: [first]
    skipIf: "\${{ steps.first.outputs.done }}"
    fallback: "\${{ inputs.fallbackValue }}"
`;
        const decl = parseWorkflowYaml(yaml);
        const second = decl.steps.second;
        expect(second.depends).toEqual(['first']);
        expect(second.skipIf).toBe('${{ steps.first.outputs.done }}');
        expect(second.fallback).toBe('${{ inputs.fallbackValue }}');
    });
});
