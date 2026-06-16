/**
 * M5 tests — KindRegistry, unified registration for routes + workflows.
 */

import { describe, it, expect } from 'vitest';
import { KindRegistry } from '../kind-registry';
import { defineRoute } from '../../route/define-route';
import { z } from 'zod';
import type { WorkflowDeclaration } from '../../workflows/types';

const noopRoute = defineRoute({
    uri: 'marketing://cohorts',
    description: 'cohorts',
    scope: ['marketing:read'],
    input: z.object({ date: z.string() }),
    output: z.object({ rows: z.array(z.any()) }),
    async handler() {
        return { rows: [] };
    },
});

const wfDecl: WorkflowDeclaration = {
    name: 'product-enablement://pipeline',
    description: 'autofill',
    version: 1,
    steps: { s1: { kind: 'route', uri: 'x' } },
};

describe('KindRegistry', () => {
    it('registers + resolves routes and workflows', () => {
        const r = new KindRegistry();
        r.registerRoute(noopRoute);
        r.registerWorkflow(wfDecl);

        const route = r.resolve('marketing://cohorts');
        expect(route?.kind).toBe('route');
        if (route?.kind !== 'route') throw new Error('unreachable');
        expect(route.route.description).toBe('cohorts');

        const wf = r.resolve('product-enablement://pipeline');
        expect(wf?.kind).toBe('workflow');
        if (wf?.kind !== 'workflow') throw new Error('unreachable');
        expect(wf.declaration.name).toBe('product-enablement://pipeline');
    });

    it('rejects duplicate URI registration as a programming error', () => {
        const r = new KindRegistry();
        r.registerRoute(noopRoute);
        expect(() => r.registerRoute(noopRoute)).toThrow(/duplicate URI/);
    });

    it('returns undefined for unknown URIs (no fallback)', () => {
        const r = new KindRegistry();
        expect(r.resolve('nope://nope')).toBeUndefined();
        expect(r.has('nope://nope')).toBe(false);
    });

    it('list() filters by kind type', () => {
        const r = new KindRegistry();
        r.registerRoute(noopRoute);
        r.registerWorkflow(wfDecl);
        expect(r.list().length).toBe(2);
        expect(r.list({ kind: 'route' }).length).toBe(1);
        expect(r.list({ kind: 'workflow' }).length).toBe(1);
    });

    it('list() filters by workspace prefix from URI', () => {
        const r = new KindRegistry();
        r.registerRoute(noopRoute);
        r.registerWorkflow(wfDecl);
        expect(r.list({ workspace: 'marketing' }).length).toBe(1);
        expect(r.list({ workspace: 'product-enablement' }).length).toBe(1);
        expect(r.list({ workspace: 'nope' }).length).toBe(0);
    });

    it('carries optional KindPolicy through registration', () => {
        const r = new KindRegistry();
        r.registerWorkflow(wfDecl, {
            cwd: 'workspace-workdir',
            workspace: 'product-enablement',
            hitl: 'available-if-user',
            idempotent: { key: '${{ inputs.productId }}', scope: 'per-key' },
        });
        const wf = r.resolve('product-enablement://pipeline');
        expect(wf?.policy?.cwd).toBe('workspace-workdir');
        expect(wf?.policy?.idempotent?.key).toBe('${{ inputs.productId }}');
    });

    it('defaults policy.cwd to workspace-workdir for agent-main workflows', () => {
        const r = new KindRegistry();
        const agentWf: WorkflowDeclaration = {
            name: 'managed-agents://example',
            description: 'an agent',
            version: 1,
            steps: {
                main: {
                    kind: 'agent',
                    model: 'claude-opus-4-7',
                    systemPrompt: 'sys',
                    prompt: 'hi',
                } as WorkflowDeclaration['steps'][string],
            },
        };
        r.registerWorkflow(agentWf);
        const wf = r.resolve('managed-agents://example');
        // Safety default — agent kinds without an explicit cwd land on
        // workspace-workdir so the workspace-allocator middleware fires.
        // Without this, agent steps would run unsandboxed.
        expect(wf?.policy?.cwd).toBe('workspace-workdir');
    });

    it('defaults policy.cwd to workspace-workdir for multi-step DAG workflows with any agent step', () => {
        // Composed-turns YAML workflows (e.g. marketing-dashboard-author,
        // recruiting-author) declare named steps — `research`, `draft`,
        // `understand`, etc. — none named `main`. The default still
        // needs to fire so SDK Read/Write/Edit/Glob/Grep stay sandboxed
        // on those agent turns.
        const r = new KindRegistry();
        const dagWf: WorkflowDeclaration = {
            name: 'workflows://composed-author',
            description: 'a composed-turns workflow',
            version: 1,
            steps: {
                research: {
                    kind: 'agent',
                    model: 'claude-opus-4-7',
                    systemPrompt: 'sys',
                    prompt: 'gather',
                } as WorkflowDeclaration['steps'][string],
                draft: {
                    kind: 'agent',
                    depends: ['research'],
                    model: 'claude-opus-4-7',
                    systemPrompt: 'sys',
                    prompt: 'compose',
                } as WorkflowDeclaration['steps'][string],
            },
        };
        r.registerWorkflow(dagWf);
        const wf = r.resolve('workflows://composed-author');
        expect(wf?.policy?.cwd).toBe('workspace-workdir');
    });

    it('does NOT apply the workspace-workdir default to pure-route DAG workflows', () => {
        // A workflow that chains only `route` steps doesn't need a
        // workdir — routes execute server-tier with their own ctx, no
        // SDK file tools in play. Default should NOT fire.
        const r = new KindRegistry();
        const routeWf: WorkflowDeclaration = {
            name: 'workflows://route-only',
            description: 'pure routes',
            version: 1,
            steps: {
                fetch: { kind: 'route', uri: 'x://a' } as WorkflowDeclaration['steps'][string],
                process: {
                    kind: 'route',
                    uri: 'x://b',
                    depends: ['fetch'],
                } as WorkflowDeclaration['steps'][string],
            },
        };
        r.registerWorkflow(routeWf);
        const wf = r.resolve('workflows://route-only');
        expect(wf?.policy?.cwd).toBeUndefined();
    });

    it('does NOT override an explicitly-pinned policy.cwd on an agent workflow', () => {
        const r = new KindRegistry();
        const agentWf: WorkflowDeclaration = {
            name: 'managed-agents://opt-out',
            description: 'pinned',
            version: 1,
            steps: {
                main: {
                    kind: 'agent',
                    model: 'claude-opus-4-7',
                    systemPrompt: 'sys',
                    prompt: 'hi',
                } as WorkflowDeclaration['steps'][string],
            },
        };
        r.registerWorkflow(agentWf, { cwd: 'ephemeral', hitl: 'never' });
        const wf = r.resolve('managed-agents://opt-out');
        expect(wf?.policy?.cwd).toBe('ephemeral');
        expect(wf?.policy?.hitl).toBe('never');
    });

    it('does NOT default cwd for non-agent-main workflows', () => {
        const r = new KindRegistry();
        const routeWf: WorkflowDeclaration = {
            name: 'cron://warmer',
            description: 'just calls a route',
            version: 1,
            steps: { main: { kind: 'route', uri: 'x' } as WorkflowDeclaration['steps'][string] },
        };
        r.registerWorkflow(routeWf);
        const wf = r.resolve('cron://warmer');
        expect(wf?.policy?.cwd).toBeUndefined();
    });

    it('unregister + clear + size', () => {
        const r = new KindRegistry();
        r.registerRoute(noopRoute);
        r.registerWorkflow(wfDecl);
        expect(r.size).toBe(2);
        expect(r.unregister('marketing://cohorts')).toBe(true);
        expect(r.size).toBe(1);
        expect(r.unregister('nope://nope')).toBe(false);
        r.clear();
        expect(r.size).toBe(0);
    });
});
