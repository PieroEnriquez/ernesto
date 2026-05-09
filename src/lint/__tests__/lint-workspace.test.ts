/**
 * Unit tests for `lintWorkspace` and `makeLintWorkspace`.
 *
 * Each test crafts a synthetic unified diff (the same shape
 * `git diff --cached` produces) and a tmpdir working tree so rules that
 * peek at the post-stage WORKSPACE.md (visibility, archived, missing) have
 * a real file to read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { lintWorkspace, makeLintWorkspace } from '../lint-workspace';

interface FailedLint {
    ok: false;
    errors: ReadonlyArray<{ code: string; workspace?: string; path?: string; message: string }>;
}

function expectErrors(result: { ok: boolean }): FailedLint {
    expect(result.ok).toBe(false);
    return result as unknown as FailedLint;
}

function diffModify(p: string, beforeBody: string, afterBody: string): string {
    const beforeLines = beforeBody.split('\n').map(l => `-${l}`);
    const afterLines = afterBody.split('\n').map(l => `+${l}`);
    return [
        `diff --git a/${p} b/${p}`,
        `index 0000001..0000002 100644`,
        `--- a/${p}`,
        `+++ b/${p}`,
        `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`,
        ...beforeLines,
        ...afterLines,
        '',
    ].join('\n');
}

function diffAdd(p: string, body: string): string {
    const addedLines = body.split('\n').map(l => `+${l}`);
    return [
        `diff --git a/${p} b/${p}`,
        `new file mode 100644`,
        `index 0000000..0000001`,
        `--- /dev/null`,
        `+++ b/${p}`,
        `@@ -0,0 +1,${addedLines.length} @@`,
        ...addedLines,
        '',
    ].join('\n');
}

function diffDelete(p: string, body: string): string {
    const removedLines = body.split('\n').map(l => `-${l}`);
    return [
        `diff --git a/${p} b/${p}`,
        `deleted file mode 100644`,
        `index 0000001..0000000`,
        `--- a/${p}`,
        `+++ /dev/null`,
        `@@ -1,${removedLines.length} +0,0 @@`,
        ...removedLines,
        '',
    ].join('\n');
}

const VALID_HR_FRONTMATTER = [
    '---',
    'name: hr',
    'description: HR policies and procedures',
    '---',
    '',
    '# HR',
    '',
    'Body content here.',
].join('\n');

async function seedWorkspace(root: string, name: string, body: string): Promise<void> {
    await mkdir(path.join(root, 'workspaces', name), { recursive: true });
    await writeFile(path.join(root, 'workspaces', name, 'WORKSPACE.md'), body);
}

async function writeStagedFile(root: string, p: string, body: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), body);
}

describe('lintWorkspace (scope-less)', () => {
    let workingTreeRoot: string;

    beforeEach(async () => {
        workingTreeRoot = await mkdtemp(path.join(tmpdir(), 'lint-ws-'));
        await seedWorkspace(workingTreeRoot, 'hr', VALID_HR_FRONTMATTER);
    });

    afterEach(async () => {
        await rm(workingTreeRoot, { recursive: true, force: true });
    });

    it('passes a happy-path edit inside a declared workspace', async () => {
        const diff = diffAdd('workspaces/hr/leave-policy.md', '# Leave Policy\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/leave-policy.md', '# Leave Policy\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        expect(result).toEqual({ ok: true });
    });

    it('flags out_of_scope_path for files outside any declared workspace', async () => {
        const diff = diffAdd('README.md', '# repo readme\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'out_of_scope_path' && e.path === 'README.md')).toBe(true);
    });

    it('flags missing_frontmatter on a new WORKSPACE.md without YAML', async () => {
        const noFm = '# HR\n\nNo frontmatter here.\n';
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/WORKSPACE.md', noFm);
        const diff = diffAdd('workspaces/hr/WORKSPACE.md', noFm);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'missing_frontmatter' && e.workspace === 'hr')).toBe(true);
    });

    it('flags invalid_frontmatter when name does not match dir', async () => {
        const body = [
            '---',
            'name: not-hr',
            'description: HR policies',
            '---',
        ].join('\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/WORKSPACE.md', body);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', '# stub\n', body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e =>
            e.code === 'invalid_frontmatter' &&
            e.workspace === 'hr' &&
            /does not match/.test(e.message),
        )).toBe(true);
    });

    it('flags private_without_admins when visibility=private and no admins', async () => {
        const body = [
            '---',
            'name: hr',
            'description: HR policies',
            'visibility: private',
            '---',
        ].join('\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/WORKSPACE.md', body);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', '# stub\n', body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'private_without_admins' && e.workspace === 'hr')).toBe(true);
    });

    it('does not flag missing_frontmatter on a partial edit whose diff omits the frontmatter block', async () => {
        // Regression: the old impl read `addedHead` from the diff's `+` lines.
        // For a mid-file insertion, `+` lines exclude the leading `---` block,
        // so the rule wrongly reported missing_frontmatter even when disk had
        // valid frontmatter. Read from disk now — this should pass.
        const partialDiff = [
            'diff --git a/workspaces/hr/WORKSPACE.md b/workspaces/hr/WORKSPACE.md',
            'index 0000001..0000002 100644',
            '--- a/workspaces/hr/WORKSPACE.md',
            '+++ b/workspaces/hr/WORKSPACE.md',
            '@@ -7,0 +8,3 @@',
            '+## New section',
            '+',
            '+Inserted text only.',
            '',
        ].join('\n');
        const result = await lintWorkspace({ diff: partialDiff, workspaces: ['hr'], workingTreeRoot });
        expect(result).toEqual({ ok: true });
    });

    it('flags forbidden_generated_path under routes/ or extracted/', async () => {
        const diff =
            diffAdd('workspaces/hr/routes/something.md', '# x\n') +
            diffAdd('workspaces/hr/extracted/sheet.md', '# y\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        const paths = failed.errors.filter(e => e.code === 'forbidden_generated_path').map(e => e.path);
        expect(paths).toContain('workspaces/hr/routes/something.md');
        expect(paths).toContain('workspaces/hr/extracted/sheet.md');
    });

    it('flags forbidden_workspace_md_delete when WORKSPACE.md is removed', async () => {
        const diff = diffDelete('workspaces/hr/WORKSPACE.md', VALID_HR_FRONTMATTER);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e =>
            e.code === 'forbidden_workspace_md_delete' &&
            e.workspace === 'hr',
        )).toBe(true);
    });

    it('flags workspace_md_missing when other files in a workspace exist without WORKSPACE.md', async () => {
        await rm(path.join(workingTreeRoot, 'workspaces', 'hr', 'WORKSPACE.md'));
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/note.md', '# n\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'workspace_md_missing' && e.workspace === 'hr')).toBe(true);
    });

    it('flags forbidden_workspace_name on an underscore-prefixed new workspace', async () => {
        const body = [
            '---',
            'name: _hidden',
            'description: x',
            '---',
        ].join('\n');
        const diff = diffAdd('workspaces/_hidden/WORKSPACE.md', body);
        const result = await lintWorkspace({ diff, workspaces: ['_hidden'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'forbidden_workspace_name' && e.workspace === '_hidden')).toBe(true);
    });

    it('flags forbidden_workspace_name on a name that fails the regex', async () => {
        const body = [
            '---',
            'name: BadName',
            'description: x',
            '---',
        ].join('\n');
        const diff = diffAdd('workspaces/BadName/WORKSPACE.md', body);
        const result = await lintWorkspace({ diff, workspaces: ['BadName'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'forbidden_workspace_name')).toBe(true);
    });

    it('flags archived_workspace_edit on writes to an archived workspace', async () => {
        const archived = [
            '---',
            'name: hr',
            'description: HR policies',
            'archived: true',
            '---',
        ].join('\n');
        await seedWorkspace(workingTreeRoot, 'hr', archived);
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/note.md', '# n\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'archived_workspace_edit' && e.workspace === 'hr')).toBe(true);
    });

    it('allows the unarchive flip on an archived workspace', async () => {
        const archived = [
            '---',
            'name: hr',
            'description: HR policies',
            'archived: true',
            '---',
        ].join('\n');
        await seedWorkspace(workingTreeRoot, 'hr', archived);
        const after = [
            '---',
            'name: hr',
            'description: HR policies',
            'archived: false',
            '---',
        ].join('\n');
        // Working tree post-stage: the WORKSPACE.md is the new (unarchived) file.
        // For the §8 archived check we read the *current* WORKSPACE.md, which
        // is still the archived one until stage flushes — keep it archived on
        // disk so the rule has the precondition to evaluate.
        const diff = diffModify('workspaces/hr/WORKSPACE.md', archived, after);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        expect(result).toEqual({ ok: true });
    });

    it('flags merge_markers on a staged file with unresolved conflict markers', async () => {
        const conflicted = [
            '# notes',
            '',
            '<<<<<<< HEAD',
            'ours',
            '=======',
            'theirs',
            '>>>>>>> origin/main',
            '',
        ].join('\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/notes.md', conflicted);
        const diff = diffAdd('workspaces/hr/notes.md', conflicted);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e =>
            e.code === 'merge_markers' && e.path === 'workspaces/hr/notes.md',
        )).toBe(true);
    });

    it('does not flag merge_markers on prose using ======= as a thematic break', async () => {
        const benign = [
            '# title',
            '',
            'Some intro.',
            '',
            '=======',
            '',
            'Section after the rule.',
            '',
        ].join('\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/notes.md', benign);
        const diff = diffAdd('workspaces/hr/notes.md', benign);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        expect(result).toEqual({ ok: true });
    });

    it('flags file_too_large when a staged file exceeds 1 MiB', async () => {
        const big = 'x'.repeat(1024 * 1024 + 1);
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/big.txt', big);
        const diff = diffAdd('workspaces/hr/big.txt', '');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'file_too_large')).toBe(true);
    });

    it('fails platform_requires_agent_ops in scope-less mode', async () => {
        await seedWorkspace(workingTreeRoot, '_platform', [
            '---',
            'name: _platform',
            'description: platform rules',
            '---',
        ].join('\n'));
        const diff = diffAdd('workspaces/_platform/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/_platform/note.md', '# n\n');
        const result = await lintWorkspace({ diff, workspaces: ['_platform'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'platform_requires_agent_ops')).toBe(true);
    });
});

describe('makeLintWorkspace(principal) — §12 visibility + _platform', () => {
    let workingTreeRoot: string;

    beforeEach(async () => {
        workingTreeRoot = await mkdtemp(path.join(tmpdir(), 'lint-ws-p-'));
        await mkdir(path.join(workingTreeRoot, 'workspaces', 'hr'), { recursive: true });
    });

    afterEach(async () => {
        await rm(workingTreeRoot, { recursive: true, force: true });
    });

    it('public workspace passes regardless of principal scopes', async () => {
        await seedWorkspace(workingTreeRoot, 'hr', VALID_HR_FRONTMATTER);
        const lint = makeLintWorkspace({ scopes: new Set(), email: 'someone@bitrefill.com' });
        const diff = diffAdd('workspaces/hr/note.md', '# note\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/note.md', '# note\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot });
        expect(result).toEqual({ ok: true });
    });

    it('private workspace denies a principal who is not an admin and lacks agent-ops', async () => {
        await seedWorkspace(workingTreeRoot, 'hr', [
            '---',
            'name: hr',
            'description: HR',
            'visibility: private',
            'admins:',
            '  - alice@bitrefill.com',
            '---',
        ].join('\n'));
        const lint = makeLintWorkspace({ scopes: new Set(['payments:read']), email: 'bob@bitrefill.com' });
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'visibility_denied' && e.workspace === 'hr')).toBe(true);
    });

    it('private workspace passes for an admin (case-insensitive email match)', async () => {
        await seedWorkspace(workingTreeRoot, 'hr', [
            '---',
            'name: hr',
            'description: HR',
            'visibility: private',
            'admins:',
            '  - Alice@Bitrefill.com',
            '---',
        ].join('\n'));
        const lint = makeLintWorkspace({ scopes: new Set(), email: 'alice@bitrefill.com' });
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot });
        expect(result).toEqual({ ok: true });
    });

    it('list visibility passes for any matching scope', async () => {
        await seedWorkspace(workingTreeRoot, 'hr', [
            '---',
            'name: hr',
            'description: HR',
            'visibility: team-a, team-b',
            '---',
        ].join('\n'));
        const lint = makeLintWorkspace({ scopes: new Set(['team-b']), email: 'x@bitrefill.com' });
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot });
        expect(result).toEqual({ ok: true });
    });

    it('list visibility fails when no scope matches and not admin/agent-ops', async () => {
        await seedWorkspace(workingTreeRoot, 'hr', [
            '---',
            'name: hr',
            'description: HR',
            'visibility: team-a, team-b',
            '---',
        ].join('\n'));
        const lint = makeLintWorkspace({ scopes: new Set(['team-c']), email: 'x@bitrefill.com' });
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'visibility_denied')).toBe(true);
    });

    it('ernesto:agent-ops bypasses visibility on any workspace', async () => {
        await seedWorkspace(workingTreeRoot, 'hr', [
            '---',
            'name: hr',
            'description: HR',
            'visibility: private',
            'admins:',
            '  - alice@bitrefill.com',
            '---',
        ].join('\n'));
        const lint = makeLintWorkspace({
            scopes: new Set(['ernesto:agent-ops']),
            email: 'ops@bitrefill.com',
        });
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot });
        expect(result).toEqual({ ok: true });
    });

    it('_platform writes pass for agent-ops principal', async () => {
        await seedWorkspace(workingTreeRoot, '_platform', [
            '---',
            'name: _platform',
            'description: platform rules',
            '---',
        ].join('\n'));
        const lint = makeLintWorkspace({
            scopes: new Set(['ernesto:agent-ops']),
            email: 'ops@bitrefill.com',
        });
        const diff = diffAdd('workspaces/_platform/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/_platform/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['_platform'], workingTreeRoot });
        expect(result).toEqual({ ok: true });
    });

    it('_platform writes fail for non-agent-ops principal even with all other scopes', async () => {
        await seedWorkspace(workingTreeRoot, '_platform', [
            '---',
            'name: _platform',
            'description: platform rules',
            '---',
        ].join('\n'));
        const lint = makeLintWorkspace({
            scopes: new Set(['hr:write', 'payments:write', 'admin']),
            email: 'admin@bitrefill.com',
        });
        const diff = diffAdd('workspaces/_platform/note.md', '# n\n');
        await writeStagedFile(workingTreeRoot, 'workspaces/_platform/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['_platform'], workingTreeRoot });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'platform_requires_agent_ops')).toBe(true);
    });
});
