/**
 * Unit tests for `compileAgent` — the §7.1 pure composer.
 *
 * Behavior under test:
 * - Pure passthrough of model, maxTurns, mcpServers, outputFormat.
 * - Defaults: declaration's `disallowedTools` wins over caller-supplied
 *   default.
 * - L2 platform-body append: reads `<cwd>/workspaces/_ernesto/WORKSPACE.md`,
 *   strips frontmatter, appends to the agent's own system prompt (both
 *   the string and preset shapes).
 * - Silent fallback when the platform body is absent or empty (laptop
 *   transport and scripts without a real clone keep working unchanged).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compileAgent, composeErnestoBody } from '../compile-agent';
import type { AgentDeclaration, AgentContext } from '../types';

const baseDecl: AgentDeclaration = {
    id: 'test',
    name: 'Test',
    description: 'unit test agent',
    model: 'claude-haiku-4-5',
    systemPrompt: 'You are a test agent.',
    maxTurns: 5,
    mcpServers: ['ernesto'],
};

const baseCtx: AgentContext = {
    cwd: undefined,
};

describe('compileAgent — pure passthrough', () => {
    it('forwards model, maxTurns, mcpServers, outputFormat untouched', () => {
        const compiled = compileAgent(
            {
                ...baseDecl,
                outputFormat: { type: 'json_schema', schema: { type: 'object' } },
            },
            baseCtx,
        );
        expect(compiled.model).toBe('claude-haiku-4-5');
        expect(compiled.maxTurns).toBe(5);
        expect(compiled.mcpServers).toEqual(['ernesto']);
        expect(compiled.outputFormat).toEqual({ type: 'json_schema', schema: { type: 'object' } });
    });

    it('returns a string systemPrompt unchanged when no workdir cwd is bound', () => {
        const r = compileAgent(baseDecl, baseCtx);
        expect(r.systemPrompt).toBe('You are a test agent.');
    });

    it('returns a preset systemPrompt structurally identical when no workdir cwd is bound', () => {
        const r = compileAgent(
            { ...baseDecl, systemPrompt: { type: 'preset', preset: 'claude_code' } },
            baseCtx,
        );
        expect(r.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: undefined });
    });

    it('preserves an explicit preset.append when no workdir cwd is bound', () => {
        const r = compileAgent(
            { ...baseDecl, systemPrompt: { type: 'preset', preset: 'claude_code', append: 'extra' } },
            baseCtx,
        );
        expect(r.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'extra' });
    });
});

describe('compileAgent — disallowedTools defaults', () => {
    it('applies the caller-supplied default when the declaration omits its own', () => {
        const r = compileAgent(baseDecl, baseCtx, { disallowedTools: ['Task', 'WebFetch'] });
        expect(r.disallowedTools).toEqual(['Task', 'WebFetch']);
    });

    it('declaration disallowedTools wins over the default', () => {
        const r = compileAgent(
            { ...baseDecl, disallowedTools: ['Bash'] },
            baseCtx,
            { disallowedTools: ['Task'] },
        );
        expect(r.disallowedTools).toEqual(['Bash']);
    });

    it('returns undefined when neither side specifies', () => {
        const r = compileAgent(baseDecl, baseCtx);
        expect(r.disallowedTools).toBeUndefined();
    });

    it('treats an explicit empty array on the declaration as "no tools disallowed"', () => {
        const r = compileAgent(
            { ...baseDecl, disallowedTools: [] },
            baseCtx,
            { disallowedTools: ['Task'] },
        );
        expect(r.disallowedTools).toEqual([]);
    });
});

describe('compileAgent — L2 platform body append', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'lib-compile-agent-'));
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    function writeErnestoBody(body: string): void {
        const dir = join(tmp, 'workspaces', '_ernesto');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'WORKSPACE.md'), body, 'utf8');
    }

    it('appends platform body to a string systemPrompt', () => {
        writeErnestoBody('Editorial guardrails: be kind.');
        const r = compileAgent(baseDecl, { cwd: tmp });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nEditorial guardrails: be kind.');
    });

    it('strips frontmatter before appending', () => {
        writeErnestoBody('---\nname: _ernesto\n---\nBody text only.\n');
        const r = compileAgent(baseDecl, { cwd: tmp });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nBody text only.\n');
    });

    it('appends platform body into preset systemPrompt.append', () => {
        writeErnestoBody('Platform note.');
        const r = compileAgent(
            { ...baseDecl, systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Prior append.' } },
            { cwd: tmp },
        );
        expect(r.systemPrompt).toEqual({
            type: 'preset',
            preset: 'claude_code',
            append: 'Prior append.\n\nPlatform note.',
        });
    });

    it('preset without a prior append still receives the platform body', () => {
        writeErnestoBody('Solo platform note.');
        const r = compileAgent(
            { ...baseDecl, systemPrompt: { type: 'preset', preset: 'claude_code' } },
            { cwd: tmp },
        );
        expect(r.systemPrompt).toEqual({
            type: 'preset',
            preset: 'claude_code',
            append: 'Solo platform note.',
        });
    });

    it('absent _ernesto/WORKSPACE.md is a silent no-op', () => {
        const r = compileAgent(baseDecl, { cwd: tmp });
        expect(r.systemPrompt).toBe('You are a test agent.');
    });

    it('empty body after stripping frontmatter is treated as absent', () => {
        writeErnestoBody('---\nname: _ernesto\n---\n\n  \n');
        const r = compileAgent(baseDecl, { cwd: tmp });
        expect(r.systemPrompt).toBe('You are a test agent.');
    });

    it('non-existent cwd is a silent no-op (not a throw)', () => {
        const r = compileAgent(baseDecl, { cwd: '/definitely/not/a/real/path/zzz' });
        expect(r.systemPrompt).toBe('You are a test agent.');
    });
});

describe('compileAgent — transport-specific platform body', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'lib-compile-agent-transport-'));
        mkdirSync(join(tmp, 'workspaces', '_ernesto'), { recursive: true });
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    function writePlatformFile(name: string, body: string): void {
        writeFileSync(join(tmp, 'workspaces', '_ernesto', name), body, 'utf8');
    }

    it('appends universal body + in-process overlay for transport "in-process"', () => {
        writePlatformFile('WORKSPACE.md', 'Universal rules.');
        writePlatformFile('in-process.md', 'In-process specifics.');
        const r = compileAgent(baseDecl, { cwd: tmp, transport: 'in-process' });
        expect(r.systemPrompt).toBe(
            'You are a test agent.\n\nUniversal rules.\n\nIn-process specifics.',
        );
    });

    it('uses mcp.md for transport "mcp"', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        writePlatformFile('in-process.md', 'In-process only.');
        writePlatformFile('mcp.md', 'MCP only.');
        const r = compileAgent(baseDecl, { cwd: tmp, transport: 'mcp' });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nUniversal.\n\nMCP only.');
    });

    it('uses the in-process overlay for transport "vm" (VM shares the in-process substrate)', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        writePlatformFile('in-process.md', 'In-process specifics.');
        const r = compileAgent(baseDecl, { cwd: tmp, transport: 'vm' });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nUniversal.\n\nIn-process specifics.');
    });

    it('a laptop transport has no injected overlay — it carries its own', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        writePlatformFile('in-process.md', 'In-process only.');
        const r = compileAgent(baseDecl, { cwd: tmp, transport: 'laptop' });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nUniversal.');
    });

    it('skips the overlay when the transport is omitted (legacy callers unaffected)', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        writePlatformFile('in-process.md', 'In-process only.');
        const r = compileAgent(baseDecl, { cwd: tmp });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nUniversal.');
    });

    it('missing overlay file falls back to universal only', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        const r = compileAgent(baseDecl, { cwd: tmp, transport: 'in-process' });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nUniversal.');
    });

    it('missing universal but present overlay emits just the overlay body', () => {
        writePlatformFile('in-process.md', 'In-process solo.');
        const r = compileAgent(baseDecl, { cwd: tmp, transport: 'in-process' });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nIn-process solo.');
    });

    it('strips frontmatter from the overlay too', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        writePlatformFile('in-process.md', '---\nname: in-process\n---\nFrontmatter-stripped overlay body.');
        const r = compileAgent(baseDecl, { cwd: tmp, transport: 'in-process' });
        expect(r.systemPrompt).toBe(
            'You are a test agent.\n\nUniversal.\n\nFrontmatter-stripped overlay body.',
        );
    });

    it('composeErnestoBody returns the concatenated body for direct (non-compileAgent) callers', () => {
        writePlatformFile('WORKSPACE.md', 'U.');
        writePlatformFile('in-process.md', 'P.');
        expect(composeErnestoBody(tmp, 'in-process')).toBe('U.\n\nP.');
    });

    it('composeErnestoBody returns null when both files are absent', () => {
        expect(composeErnestoBody(tmp, 'in-process')).toBeNull();
    });

    it('composeErnestoBody returns null when cwd is undefined', () => {
        expect(composeErnestoBody(undefined, 'in-process')).toBeNull();
    });
});
