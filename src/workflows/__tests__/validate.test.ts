/**
 * One test per workflow_* lint code. Each constructs the minimum
 * failing workflow + asserts the error code fires.
 */

import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '../validate';
import type { WorkflowDeclaration } from '../types';

function baseDecl(overrides: Partial<WorkflowDeclaration> = {}): WorkflowDeclaration {
    return {
        name: 'demo',
        description: 'demo',
        version: 1,
        steps: {
            main: {
                kind: 'agent',
                model: 'm',
                systemPrompt: 'sys',
                prompt: 'p',
                next: 'outputs.r',
            },
        },
        outputs: { r: { from: 'main' } },
        ...overrides,
    };
}

describe('validateWorkflow', () => {
    it('emits workflow_name_mismatch when filename stem ≠ name', () => {
        const res = validateWorkflow(baseDecl(), { filename: 'other.yaml' });
        expect(res.ok).toBe(false);
        expect(res.errors.find(e => e.code === 'workflow_name_mismatch')).toBeTruthy();
    });

    it('accepts when filename stem === name', () => {
        const res = validateWorkflow(baseDecl(), { filename: 'demo.yaml' });
        expect(res.errors.some(e => e.code === 'workflow_name_mismatch')).toBe(false);
    });

    it('accepts ${{ workspace.root }} / ${{ workspace.name }} references (reader-resolved)', () => {
        const decl = baseDecl({
            steps: {
                main: {
                    kind: 'agent', model: 'm', systemPrompt: 'sys',
                    prompt: 'Read ${{ workspace.root }}/rubric.md for ${{ workspace.name }}',
                    next: 'outputs.r',
                },
            },
        });
        const res = validateWorkflow(decl, { filename: 'demo.yaml' });
        expect(res.errors.some(e => e.code === 'workflow_template_unresolved')).toBe(false);
    });

    it('still rejects an unknown reference root', () => {
        const decl = baseDecl({
            steps: {
                main: {
                    kind: 'agent', model: 'm', systemPrompt: 'sys',
                    prompt: '${{ bogus.field }}', next: 'outputs.r',
                },
            },
        });
        const res = validateWorkflow(decl, { filename: 'demo.yaml' });
        expect(res.errors.some(e => e.code === 'workflow_template_unresolved')).toBe(true);
    });

    it('emits workflow_step_unreachable for a depends on an unknown step', () => {
        const decl = baseDecl({
            steps: {
                first: { kind: 'route', uri: 'r://x' },
                second: { kind: 'route', uri: 'r://y', depends: ['ghost'] },
            },
            outputs: { r: { from: 'first' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e => e.code === 'workflow_step_unreachable' && e.stepId === 'second')).toBe(true);
    });

    it('emits workflow_step_dead_end for a depends cycle', () => {
        const decl = baseDecl({
            steps: {
                a: { kind: 'route', uri: 'r://x', depends: ['b'] },
                b: { kind: 'route', uri: 'r://y', depends: ['a'] },
            },
            outputs: { r: { from: 'a' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e => e.code === 'workflow_step_dead_end')).toBe(true);
    });

    it('accepts a plain multi-root DAG (independent sinks are valid)', () => {
        const decl = baseDecl({
            steps: {
                one: { kind: 'route', uri: 'r://x' },
                two: { kind: 'route', uri: 'r://y' },
            },
            outputs: { r: { from: 'one' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e => e.code === 'workflow_step_unreachable')).toBe(false);
        expect(res.errors.some(e => e.code === 'workflow_step_dead_end')).toBe(false);
    });

    it('emits workflow_unknown_kind for a foreign step kind', () => {
        const decl = baseDecl({
            steps: {
                // bypass the type checker — simulating a YAML-driven foreign kind
                main: { kind: 'sortof' as 'route', uri: 'x', next: 'outputs' } as never,
            },
            outputs: { r: { from: 'main' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e => e.code === 'workflow_unknown_kind')).toBe(true);
    });

    it('emits workflow_unknown_route when ctx.knownRoutes lacks the uri', () => {
        const decl = baseDecl({
            steps: {
                main: { kind: 'route', uri: 'redshift://bogus', next: 'outputs' },
            },
            outputs: { r: { from: 'main' } },
        });
        const res = validateWorkflow(decl, { knownRoutes: new Set(['redshift://query']) });
        expect(res.errors.some(e => e.code === 'workflow_unknown_route')).toBe(true);
    });

    it('accepts when ctx.knownRoutes includes the uri', () => {
        const decl = baseDecl({
            steps: {
                main: { kind: 'route', uri: 'redshift://query', next: 'outputs' },
            },
            outputs: { r: { from: 'main' } },
        });
        const res = validateWorkflow(decl, { knownRoutes: new Set(['redshift://query']) });
        expect(res.errors.some(e => e.code === 'workflow_unknown_route')).toBe(false);
    });

    it('emits workflow_unknown_harness when explicit harness is not in registered set', () => {
        const decl = baseDecl({
            steps: {
                main: {
                    kind: 'agent',
                    harness: 'fragua-pi' as never,
                    model: 'm',
                    systemPrompt: 'sys', prompt: 'p', next: 'outputs.r',
                },
            },
            outputs: { r: { from: 'main' } },
        });
        const res = validateWorkflow(decl, { knownHarnesses: new Set(['cas', 'cursor']) });
        expect(res.errors.some(e => e.code === 'workflow_unknown_harness')).toBe(true);
    });

    it('emits workflow_unknown_harness with a "did you mean" hint on typo', () => {
        const decl = baseDecl({
            steps: {
                main: {
                    kind: 'agent',
                    harness: 'claude' as never,
                    model: 'm',
                    systemPrompt: 'sys', prompt: 'p', next: 'outputs.r',
                },
            },
            outputs: { r: { from: 'main' } },
        });
        const res = validateWorkflow(decl, {
            knownHarnesses: new Set(['cas', 'cursor']),
        });
        const hit = res.errors.find(e => e.code === 'workflow_unknown_harness');
        expect(hit).toBeTruthy();
        expect(hit?.message).toMatch(/did you mean cas\?/);
    });

    it('accepts a known harness: cursor under knownHarnesses', () => {
        const decl = baseDecl({
            steps: {
                main: {
                    kind: 'agent',
                    harness: 'cursor',
                    model: 'm',
                    systemPrompt: 'sys', prompt: 'p', next: 'outputs.r',
                },
            },
            outputs: { r: { from: 'main' } },
        });
        const res = validateWorkflow(decl, {
            knownHarnesses: new Set(['cas', 'cursor', 'fragua-pi']),
        });
        expect(res.errors.some(e => e.code === 'workflow_unknown_harness')).toBe(false);
    });

    it('emits workflow_scope_widens when workflow scope exceeds workspace scope', () => {
        const decl = baseDecl({
            scope: ['payments:read', 'admin:*'],
            steps: {
                main: {
                    kind: 'route',
                    uri: 'r://q',
                    next: 'outputs.r',
                },
            },
            outputs: { r: { from: 'main' } },
        });
        const res = validateWorkflow(decl, {
            declaredWorkspaceScopes: ['payments:read'],
        });
        expect(res.errors.some(e => e.code === 'workflow_scope_widens')).toBe(true);
    });

    it('emits workflow_template_unresolved for unknown inputs.* refs', () => {
        const decl = baseDecl({
            steps: {
                main: {
                    kind: 'agent', model: 'm', systemPrompt: 'sys',
                    prompt: 'use {{ inputs.missing }}',
                    next: 'outputs.r',
                },
            },
            inputs: { other: { type: 'string' } },
            outputs: { r: { from: 'main' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e => e.code === 'workflow_template_unresolved')).toBe(true);
    });

    it('emits workflow_template_unresolved for unknown steps.* refs', () => {
        const decl = baseDecl({
            steps: {
                main: {
                    kind: 'agent', model: 'm', systemPrompt: 'sys',
                    prompt: 'use {{ steps.bogus.output }}',
                    next: 'outputs.r',
                },
            },
            outputs: { r: { from: 'main' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e => e.code === 'workflow_template_unresolved')).toBe(true);
    });

    it('accepts valid template refs to inputs.*, steps.*.output, and context.*', () => {
        const decl = baseDecl({
            inputs: { product: { type: 'string' } },
            steps: {
                a: { kind: 'route', uri: 'r://q', params: { x: '${{ inputs.product }}' }, next: 'b' },
                b: {
                    kind: 'agent', model: 'm', systemPrompt: 'sys',
                    prompt: '{{ steps.a.output }} for {{ context.tier }}',
                    next: 'outputs.r',
                },
            },
            outputs: { r: { from: 'b' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e => e.code === 'workflow_template_unresolved')).toBe(false);
    });

    it('emits workflow_input_schema_invalid for unknown JSON Schema type', () => {
        const decl = baseDecl({
            steps: {
                pick: {
                    kind: 'input',
                    schema: { type: 'banana' },
                    prompt: 'pick',
                    next: 'outputs.r',
                },
            },
            outputs: { r: { from: 'pick' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e => e.code === 'workflow_input_schema_invalid')).toBe(true);
    });

    it('emits workflow_input_schema_invalid for non-object schema', () => {
        const decl = baseDecl({
            steps: {
                pick: {
                    kind: 'input',
                    schema: ['nope'] as unknown as Record<string, unknown>,
                    prompt: 'pick',
                    next: 'outputs.r',
                },
            },
            outputs: { r: { from: 'pick' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e => e.code === 'workflow_input_schema_invalid')).toBe(true);
    });

    it('collects multiple errors in a single pass (no short-circuit)', () => {
        const decl: WorkflowDeclaration = {
            name: 'demo',
            description: 'd',
            version: 1,
            steps: {
                ok: { kind: 'route', uri: 'r://x' },
                broken: { kind: 'route', uri: 'r://y', depends: ['ghost'] }, // unknown dep
                alsoBad: { kind: 'bogus' as 'route', uri: 'r://z' }, // unknown kind
            },
        };
        const res = validateWorkflow(decl);
        expect(res.ok).toBe(false);
        const codes = res.errors.map(e => e.code);
        expect(codes).toContain('workflow_unknown_kind');
        expect(codes).toContain('workflow_step_unreachable');
    });

    it('outputs.<name>.from referencing an unknown step is reported via workflow_template_unresolved', () => {
        const decl = baseDecl({
            outputs: { r: { from: 'ghost' } },
        });
        const res = validateWorkflow(decl);
        expect(res.errors.some(e =>
            e.code === 'workflow_template_unresolved' &&
            e.field === 'outputs.r.from',
        )).toBe(true);
    });
});
