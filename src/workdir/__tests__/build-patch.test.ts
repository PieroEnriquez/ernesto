/**
 * Unit tests for `buildSettlePatch` — the shared patch-construction shape
 * used by the laptop transport today and the mcp transport (a remote MCP
 * client) once it lands. Pathspec exclusions match the §22 settle gate:
 * `extracted/` and `attached/` per-workspace subtrees never enter the
 * dev's settle commit (the derive worker owns one, master-fs owns the
 * other).
 */
import { describe, it, expect } from 'vitest';
import { promises as fsp, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { buildSettlePatch } from '../build-patch';
import { setupBareRepo } from '../../__tests__/kit';

const pExecFile = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await pExecFile('git', args, { cwd });
    return stdout;
}

async function makeCloneWithWorkspaces(): Promise<{ root: string; parentSha: string }> {
    // Bare upstream seeded with the two workspaces (kit), then a working-tree clone.
    const { bareRoot } = await setupBareRepo({
        'workspaces/alpha/WORKSPACE.md': '---\nname: alpha\n---\nseed\n',
        'workspaces/beta/WORKSPACE.md': '---\nname: beta\n---\nseed\n',
    });
    const tmp = mkdtempSync(join(tmpdir(), 'ernesto-lib-buildpatch-'));
    const root = join(tmp, 'clone');
    await fsp.mkdir(root, { recursive: true });
    await git(root, ['clone', '-q', '--branch', 'main', '--single-branch', bareRoot, '.']);
    await git(root, ['config', 'user.email', 't@b.com']);
    await git(root, ['config', 'user.name', 't']);
    await git(root, ['config', 'commit.gpgsign', 'false']);
    const parentSha = (await git(root, ['rev-parse', 'HEAD'])).trim();
    return { root, parentSha };
}

describe('buildSettlePatch', () => {
    it('produces a patch for an edit in the named workspace and reports the right parentSha', async () => {
        const { root, parentSha } = await makeCloneWithWorkspaces();

        await fsp.writeFile(join(root, 'workspaces', 'alpha', 'WORKSPACE.md'), '---\nname: alpha\n---\nedited\n');

        const r = await buildSettlePatch(root, ['alpha']);
        expect(r.parentSha).toBe(parentSha);
        expect(r.patch).toContain('workspaces/alpha/WORKSPACE.md');
        expect(r.patch).toContain('edited');
    });

    it('returns an empty patch when nothing in the named workspace changed', async () => {
        const { root } = await makeCloneWithWorkspaces();
        const r = await buildSettlePatch(root, ['alpha']);
        expect(r.patch).toBe('');
    });

    it('excludes extracted/ and attached/ subtrees from the patch', async () => {
        const { root } = await makeCloneWithWorkspaces();

        // Real edit: should land in the patch.
        await fsp.writeFile(join(root, 'workspaces', 'alpha', 'WORKSPACE.md'), '---\nname: alpha\n---\nedited body\n');

        // Edits under extracted/ and attached/ must NOT appear (they belong
        // to the derive worker / master-fs, not the dev's settle commit).
        await fsp.mkdir(join(root, 'workspaces', 'alpha', 'extracted'), { recursive: true });
        await fsp.writeFile(join(root, 'workspaces', 'alpha', 'extracted', 'leaf.md'), 'extracted body\n');
        await fsp.mkdir(join(root, 'workspaces', 'alpha', 'attached'), { recursive: true });
        await fsp.writeFile(join(root, 'workspaces', 'alpha', 'attached', 'doc.md'), 'attached body\n');

        const r = await buildSettlePatch(root, ['alpha']);
        expect(r.patch).toContain('workspaces/alpha/WORKSPACE.md');
        expect(r.patch).toContain('edited body');
        expect(r.patch).not.toContain('extracted/leaf.md');
        expect(r.patch).not.toContain('attached/doc.md');
        expect(r.patch).not.toContain('extracted body');
        expect(r.patch).not.toContain('attached body');
    });

    it('carries attachments.yaml but excludes the .derived-from-sha overlay', async () => {
        // attachments.yaml is a tracked git file (attach/detach author it as a
        // pending edit of the calling session), so the laptop-patch staging
        // must carry it — matching the worktree settle gate. .derived-from-sha
        // stays a master-fs mirror and must never ride along.
        const { root } = await makeCloneWithWorkspaces();

        await fsp.writeFile(join(root, 'workspaces', 'alpha', 'WORKSPACE.md'), '---\nname: alpha\n---\nreal edit\n');
        await fsp.writeFile(join(root, 'workspaces', 'alpha', 'attachments.yaml'), '- name: playbook.pdf\n');
        await fsp.writeFile(join(root, 'workspaces', 'alpha', '.derived-from-sha'), 'deadbeef\n');

        const r = await buildSettlePatch(root, ['alpha']);
        expect(r.patch).toContain('workspaces/alpha/WORKSPACE.md');
        expect(r.patch).toContain('real edit');
        expect(r.patch).toContain('workspaces/alpha/attachments.yaml');
        expect(r.patch).toContain('playbook.pdf');
        expect(r.patch).not.toContain('.derived-from-sha');
        expect(r.patch).not.toContain('deadbeef');
    });

    it('stages multiple workspaces in one call', async () => {
        const { root } = await makeCloneWithWorkspaces();
        await fsp.writeFile(join(root, 'workspaces', 'alpha', 'WORKSPACE.md'), '---\nname: alpha\n---\nA changed\n');
        await fsp.writeFile(join(root, 'workspaces', 'beta', 'WORKSPACE.md'), '---\nname: beta\n---\nB changed\n');
        const r = await buildSettlePatch(root, ['alpha', 'beta']);
        expect(r.patch).toContain('workspaces/alpha/WORKSPACE.md');
        expect(r.patch).toContain('workspaces/beta/WORKSPACE.md');
    });
});
