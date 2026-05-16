/**
 * Unit tests for `discoverManagedAgents` — the filesystem walk that
 * boot uses to project `workspaces/*\/managed-agents/*.md` into the
 * runtime registry. Errors land in the result (not thrown) so boot
 * always completes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverManagedAgents } from '../discover';

let root: string;

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'discover-managed-agents-'));
});

afterEach(() => {
    rmSync(root, { recursive: true, force: true });
});

function writeAgent(workspace: string, slug: string, body = 'body text'): void {
    const dir = join(root, workspace, 'managed-agents');
    mkdirSync(dir, { recursive: true });
    const md = `---
slug: ${slug}
name: ${slug}
description: test
model: claude-haiku-4-5
maxTurns: 1
---

${body}
`;
    writeFileSync(join(dir, `${slug}.md`), md, 'utf8');
}

describe('discoverManagedAgents', () => {
    it('returns empty result when the root does not exist', () => {
        const r = discoverManagedAgents('/definitely/not/a/real/path/xyz');
        expect(r.agents).toEqual([]);
        expect(r.errors).toEqual([]);
    });

    it('finds agents across multiple workspaces', () => {
        writeAgent('payments', 'analyst');
        writeAgent('payments', 'weekly-insights');
        writeAgent('qa', 'web-runner');
        const r = discoverManagedAgents(root);
        expect(r.errors).toEqual([]);
        const ids = r.agents.map(a => a.declaration.id).sort();
        expect(ids).toEqual(['analyst', 'web-runner', 'weekly-insights']);
        const workspaces = r.agents.map(a => a.workspace).sort();
        expect(workspaces).toEqual(['payments', 'payments', 'qa']);
    });

    it('skips workspaces without a managed-agents directory', () => {
        // Workspace exists but no managed-agents/ subfolder
        mkdirSync(join(root, 'plain'), { recursive: true });
        writeFileSync(join(root, 'plain', 'WORKSPACE.md'), '---\nname: plain\n---\n');
        writeAgent('payments', 'analyst');
        const r = discoverManagedAgents(root);
        expect(r.agents.map(a => a.declaration.id)).toEqual(['analyst']);
    });

    it('skips dotfiles at workspace level (e.g. .git)', () => {
        mkdirSync(join(root, '.git'), { recursive: true });
        writeAgent('payments', 'analyst');
        const r = discoverManagedAgents(root);
        expect(r.agents.map(a => a.declaration.id)).toEqual(['analyst']);
    });

    it('collects parse errors without throwing', () => {
        const dir = join(root, 'broken', 'managed-agents');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'bad.md'), 'no frontmatter at all\n', 'utf8');
        writeAgent('payments', 'analyst');

        const r = discoverManagedAgents(root);
        expect(r.agents.map(a => a.declaration.id)).toEqual(['analyst']);
        expect(r.errors).toHaveLength(1);
        expect(r.errors[0].slug).toBe('bad');
        expect(r.errors[0].workspace).toBe('broken');
        expect(r.errors[0].error.message).toMatch(/missing YAML frontmatter/);
    });

    it('records sourcePath for each agent', () => {
        writeAgent('payments', 'analyst');
        const r = discoverManagedAgents(root);
        expect(r.agents[0].sourcePath).toBe(join(root, 'payments', 'managed-agents', 'analyst.md'));
    });
});
