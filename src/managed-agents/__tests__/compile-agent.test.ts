/**
 * Unit tests for `compileAgent` — the §7.1 pure composer.
 *
 * Behavior under test:
 * - Pure passthrough of model, maxTurns, mcpServers, outputFormat.
 * - Defaults: declaration's `disallowedTools` wins over caller-supplied
 *   default.
 * - L2 platform-body append: reads `<cwd>/workspaces/_platform/WORKSPACE.md`,
 *   strips frontmatter, appends to the agent's own system prompt (both
 *   the string and preset shapes).
 * - Silent fallback when the platform body is absent or empty (Tier-C
 *   and scripts without a real clone keep working unchanged).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { compileAgent, composePlatformBody } from '../compile-agent';
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
    session: { id: 'sess-1' },
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

    function writePlatformBody(body: string): void {
        const dir = join(tmp, 'workspaces', '_platform');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'WORKSPACE.md'), body, 'utf8');
    }

    it('appends platform body to a string systemPrompt', () => {
        writePlatformBody('Editorial guardrails: be kind.');
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp } });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nEditorial guardrails: be kind.');
    });

    it('strips frontmatter before appending', () => {
        writePlatformBody('---\nname: _platform\n---\nBody text only.\n');
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp } });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nBody text only.\n');
    });

    it('appends platform body into preset systemPrompt.append', () => {
        writePlatformBody('Platform note.');
        const r = compileAgent(
            { ...baseDecl, systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Prior append.' } },
            { session: { id: 'x', cwd: tmp } },
        );
        expect(r.systemPrompt).toEqual({
            type: 'preset',
            preset: 'claude_code',
            append: 'Prior append.\n\nPlatform note.',
        });
    });

    it('preset without a prior append still receives the platform body', () => {
        writePlatformBody('Solo platform note.');
        const r = compileAgent(
            { ...baseDecl, systemPrompt: { type: 'preset', preset: 'claude_code' } },
            { session: { id: 'x', cwd: tmp } },
        );
        expect(r.systemPrompt).toEqual({
            type: 'preset',
            preset: 'claude_code',
            append: 'Solo platform note.',
        });
    });

    it('absent _platform/WORKSPACE.md is a silent no-op', () => {
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp } });
        expect(r.systemPrompt).toBe('You are a test agent.');
    });

    it('empty body after stripping frontmatter is treated as absent', () => {
        writePlatformBody('---\nname: _platform\n---\n\n  \n');
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp } });
        expect(r.systemPrompt).toBe('You are a test agent.');
    });

    it('non-existent cwd is a silent no-op (not a throw)', () => {
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: '/definitely/not/a/real/path/zzz' } });
        expect(r.systemPrompt).toBe('You are a test agent.');
    });
});

describe('compileAgent — tier-specific platform body', () => {
    let tmp: string;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'lib-compile-agent-tier-'));
        mkdirSync(join(tmp, 'workspaces', '_platform'), { recursive: true });
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
    });

    function writePlatformFile(name: string, body: string): void {
        writeFileSync(join(tmp, 'workspaces', '_platform', name), body, 'utf8');
    }

    it('appends universal body + tier-a body when tier: "A" is set', () => {
        writePlatformFile('WORKSPACE.md', 'Universal rules.');
        writePlatformFile('tier-a.md', 'Tier A specifics.');
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp }, tier: 'A' });
        expect(r.systemPrompt).toBe(
            'You are a test agent.\n\nUniversal rules.\n\nTier A specifics.',
        );
    });

    it('uses tier-b.md when tier: "B"', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        writePlatformFile('tier-a.md', 'A only.');
        writePlatformFile('tier-b.md', 'B only.');
        writePlatformFile('tier-c.md', 'C only.');
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp }, tier: 'B' });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nUniversal.\n\nB only.');
    });

    it('skips tier append when tier is omitted (legacy callers unaffected)', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        writePlatformFile('tier-a.md', 'A only.');
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp } });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nUniversal.');
    });

    it('missing tier-{tier}.md falls back to universal only', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp }, tier: 'C' });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nUniversal.');
    });

    it('missing universal but present tier file emits just the tier body', () => {
        writePlatformFile('tier-a.md', 'Tier A solo.');
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp }, tier: 'A' });
        expect(r.systemPrompt).toBe('You are a test agent.\n\nTier A solo.');
    });

    it('strips frontmatter from the tier file too', () => {
        writePlatformFile('WORKSPACE.md', 'Universal.');
        writePlatformFile('tier-a.md', '---\nname: tier-a\n---\nFrontmatter-stripped tier body.');
        const r = compileAgent(baseDecl, { session: { id: 'x', cwd: tmp }, tier: 'A' });
        expect(r.systemPrompt).toBe(
            'You are a test agent.\n\nUniversal.\n\nFrontmatter-stripped tier body.',
        );
    });

    it('composePlatformBody returns the concatenated body for direct (non-compileAgent) callers', () => {
        writePlatformFile('WORKSPACE.md', 'U.');
        writePlatformFile('tier-c.md', 'C.');
        expect(composePlatformBody(tmp, 'C')).toBe('U.\n\nC.');
    });

    it('composePlatformBody returns null when both files are absent', () => {
        expect(composePlatformBody(tmp, 'A')).toBeNull();
    });

    it('composePlatformBody returns null when cwd is undefined', () => {
        expect(composePlatformBody(undefined, 'A')).toBeNull();
    });
});
