/**
 * Unit tests for `lintWorkspace` and `makeLintWorkspace`.
 *
 * Each fixture is a real git repo so `git show HEAD:...` (used for the
 * old-vs-new frontmatter comparison) returns the committed state. The
 * test then writes the post-stage file to disk and feeds the lint a
 * synthetic unified diff matching what `git diff --cached` would emit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { lintWorkspace, makeLintWorkspace } from '../lint-workspace';

const pExec = promisify(execFile);

interface FailedLint {
    ok: false;
    errors: ReadonlyArray<{ code: string; workspace?: string; path?: string; message: string }>;
}
function expectErrors(result: { ok: boolean }): FailedLint {
    expect(result.ok).toBe(false);
    return result as unknown as FailedLint;
}

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await pExec('git', args, {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
}

async function initRepo(root: string): Promise<void> {
    await git(root, ['init', '-q', '-b', 'main']);
    await git(root, ['config', 'user.email', 'test@bitrefill.com']);
    await git(root, ['config', 'user.name', 'Test']);
    await git(root, ['config', 'commit.gpgsign', 'false']);
}

async function commitAll(root: string, msg: string): Promise<void> {
    await git(root, ['add', '-A']);
    await git(root, ['commit', '-q', '-m', msg]);
}

async function seedWorkspace(root: string, name: string, body: string): Promise<void> {
    await mkdir(path.join(root, 'workspaces', name), { recursive: true });
    await writeFile(path.join(root, 'workspaces', name, 'WORKSPACE.md'), body);
}

async function writeStagedFile(root: string, p: string, body: string): Promise<void> {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), body);
}

function diffModify(p: string, beforeBody: string, afterBody: string): string {
    const before = beforeBody.split('\n').map(l => `-${l}`);
    const after = afterBody.split('\n').map(l => `+${l}`);
    return [
        `diff --git a/${p} b/${p}`,
        `index 0000001..0000002 100644`,
        `--- a/${p}`,
        `+++ b/${p}`,
        `@@ -1,${before.length} +1,${after.length} @@`,
        ...before,
        ...after,
        '',
    ].join('\n');
}

function diffAdd(p: string, body: string): string {
    const added = body.split('\n').map(l => `+${l}`);
    return [
        `diff --git a/${p} b/${p}`,
        `new file mode 100644`,
        `index 0000000..0000001`,
        `--- /dev/null`,
        `+++ b/${p}`,
        `@@ -0,0 +1,${added.length} @@`,
        ...added,
        '',
    ].join('\n');
}

function diffDelete(p: string, body: string): string {
    const removed = body.split('\n').map(l => `-${l}`);
    return [
        `diff --git a/${p} b/${p}`,
        `deleted file mode 100644`,
        `index 0000001..0000000`,
        `--- a/${p}`,
        `+++ /dev/null`,
        `@@ -1,${removed.length} +0,0 @@`,
        ...removed,
        '',
    ].join('\n');
}

const VALID_HR = [
    '---',
    'name: hr',
    'description: HR policies and procedures',
    'admin: hr-admin',
    '---',
    '',
    '# HR',
    '',
    'Body content here.',
].join('\n');

describe('lintWorkspace (scope-less)', () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'lint-ws-'));
        await initRepo(root);
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('passes a happy-path edit inside a declared workspace', async () => {
        await writeStagedFile(root, 'workspaces/hr/leave-policy.md', '# Leave Policy\n');
        const diff = diffAdd('workspaces/hr/leave-policy.md', '# Leave Policy\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('flags out_of_scope_path for files outside any declared workspace', async () => {
        const diff = diffAdd('README.md', '# repo readme\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'out_of_scope_path' && e.path === 'README.md')).toBe(true);
    });

    it('flags missing_frontmatter on a new WORKSPACE.md without YAML', async () => {
        const noFm = '# HR\n\nNo frontmatter here.\n';
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', noFm);
        const diff = diffAdd('workspaces/hr/WORKSPACE.md', noFm);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'missing_frontmatter' && e.workspace === 'hr')).toBe(true);
    });

    it('flags invalid_frontmatter when name does not match dir', async () => {
        const body = [
            '---',
            'name: not-hr',
            'description: HR',
            'admin: hr-admin',
            '---',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', body);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e =>
            e.code === 'invalid_frontmatter' &&
            e.workspace === 'hr' &&
            /does not match/.test(e.message),
        )).toBe(true);
    });

    it('flags invalid_frontmatter when admin is missing', async () => {
        const body = [
            '---',
            'name: hr',
            'description: HR',
            '---',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', body);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e =>
            e.code === 'invalid_frontmatter' &&
            e.workspace === 'hr' &&
            /admin/.test(e.message),
        )).toBe(true);
    });

    it('flags forbidden_generated_path under routes/ or extracted/', async () => {
        const diff =
            diffAdd('workspaces/hr/routes/something.md', '# x\n') +
            diffAdd('workspaces/hr/extracted/sheet.md', '# y\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        const paths = failed.errors.filter(e => e.code === 'forbidden_generated_path').map(e => e.path);
        expect(paths).toContain('workspaces/hr/routes/something.md');
        expect(paths).toContain('workspaces/hr/extracted/sheet.md');
    });

    it('flags forbidden_workspace_md_delete when WORKSPACE.md is removed', async () => {
        const diff = diffDelete('workspaces/hr/WORKSPACE.md', VALID_HR);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e =>
            e.code === 'forbidden_workspace_md_delete' &&
            e.workspace === 'hr',
        )).toBe(true);
    });

    it('flags workspace_md_missing when other files in a workspace exist without WORKSPACE.md', async () => {
        await rm(path.join(root, 'workspaces', 'hr', 'WORKSPACE.md'));
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'workspace_md_missing' && e.workspace === 'hr')).toBe(true);
    });

    it('flags forbidden_workspace_name on an underscore-prefixed new workspace', async () => {
        const body = [
            '---',
            'name: _hidden',
            'description: x',
            'admin: hidden-admin',
            '---',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/_hidden/WORKSPACE.md', body);
        const diff = diffAdd('workspaces/_hidden/WORKSPACE.md', body);
        const result = await lintWorkspace({ diff, workspaces: ['_hidden'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'forbidden_workspace_name' && e.workspace === '_hidden')).toBe(true);
    });

    it('flags forbidden_workspace_name on a name that fails the regex', async () => {
        const body = [
            '---',
            'name: BadName',
            'description: x',
            'admin: bad-admin',
            '---',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/BadName/WORKSPACE.md', body);
        const diff = diffAdd('workspaces/BadName/WORKSPACE.md', body);
        const result = await lintWorkspace({ diff, workspaces: ['BadName'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'forbidden_workspace_name')).toBe(true);
    });

    it('flags archived_workspace_edit on writes to an archived workspace', async () => {
        const archived = [
            '---',
            'name: hr',
            'description: HR',
            'admin: hr-admin',
            'archived: true',
            '---',
        ].join('\n');
        await seedWorkspace(root, 'hr', archived);
        await commitAll(root, 'archive');
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'archived_workspace_edit' && e.workspace === 'hr')).toBe(true);
    });

    it('flags file_too_large when a staged file exceeds 1 MiB', async () => {
        const big = 'x'.repeat(1024 * 1024 + 1);
        await writeStagedFile(root, 'workspaces/hr/big.txt', big);
        const diff = diffAdd('workspaces/hr/big.txt', '');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'file_too_large')).toBe(true);
    });

    it('flags merge_markers on staged files with unresolved conflict markers', async () => {
        const conflicted = [
            '# notes', '',
            '<<<<<<< HEAD',
            'ours',
            '=======',
            'theirs',
            '>>>>>>> origin/main', '',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/notes.md', conflicted);
        const diff = diffAdd('workspaces/hr/notes.md', conflicted);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'merge_markers')).toBe(true);
    });

    it('does not flag merge_markers on prose using ======= as a thematic break', async () => {
        const benign = [
            '# title', '', 'Some intro.', '', '=======', '', 'Section after.', '',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/notes.md', benign);
        const diff = diffAdd('workspaces/hr/notes.md', benign);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('flags attachments_hand_edit on any user-initiated touch', async () => {
        await writeStagedFile(root, 'workspaces/hr/attachments.yaml', '- url: http://example.com\n');
        const diff = diffAdd('workspaces/hr/attachments.yaml', '- url: http://example.com\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'attachments_hand_edit')).toBe(true);
    });
});

describe('makeLintWorkspace(principal) — read/write/admin scopes', () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'lint-ws-p-'));
        await initRepo(root);
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('public-default workspace: any principal can write prose', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({ scopes: new Set([]), email: 'random@bitrefill.com' });
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('read_denied when read scope set and principal lacks it', async () => {
        const restricted = [
            '---',
            'name: hr', 'description: HR',
            'read: hr-read',
            'write: hr-write',
            'admin: hr-admin',
            '---',
        ].join('\n');
        await seedWorkspace(root, 'hr', restricted);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({ scopes: new Set(['payments:read']), email: 'x@bitrefill.com' });
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'read_denied' && e.workspace === 'hr')).toBe(true);
    });

    it('write_denied when read passes but write scope is missing', async () => {
        const restricted = [
            '---',
            'name: hr', 'description: HR',
            'read: hr-read',
            'write: hr-write',
            'admin: hr-admin',
            '---',
        ].join('\n');
        await seedWorkspace(root, 'hr', restricted);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({ scopes: new Set(['hr-read']), email: 'x@bitrefill.com' });
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'write_denied')).toBe(true);
    });

    it('write scope passes prose edits', async () => {
        const restricted = [
            '---',
            'name: hr', 'description: HR',
            'read: hr-read', 'write: hr-write', 'admin: hr-admin',
            '---',
        ].join('\n');
        await seedWorkspace(root, 'hr', restricted);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({ scopes: new Set(['hr-write']), email: 'x@bitrefill.com' });
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('admin_denied when modifying WORKSPACE.md frontmatter without admin', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        const newFm = [
            '---',
            'name: hr', 'description: HR (rephrased)',
            'admin: hr-admin',
            '---',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newFm);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, newFm);
        const lint = makeLintWorkspace({ scopes: new Set([]), email: 'x@bitrefill.com' });
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'admin_denied')).toBe(true);
    });

    it('WORKSPACE.md body-only edit only requires write', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        const sameFmNewBody = [
            '---',
            'name: hr',
            'description: HR policies and procedures',
            'admin: hr-admin',
            '---',
            '',
            '# HR',
            '',
            'New body content.',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', sameFmNewBody);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, sameFmNewBody);
        const lint = makeLintWorkspace({ scopes: new Set([]), email: 'x@bitrefill.com' });
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('admin scope satisfies frontmatter changes', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        const newFm = [
            '---',
            'name: hr', 'description: HR (rephrased)',
            'admin: hr-admin',
            '---',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newFm);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, newFm);
        const lint = makeLintWorkspace({ scopes: new Set(['hr-admin']), email: 'x@bitrefill.com' });
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('ernesto:agent-ops bypasses everything', async () => {
        const restricted = [
            '---',
            'name: hr', 'description: HR',
            'read: hr-read', 'write: hr-write', 'admin: hr-admin',
            '---',
        ].join('\n');
        await seedWorkspace(root, 'hr', restricted);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({
            scopes: new Set(['ernesto:agent-ops']),
            email: 'ops@bitrefill.com',
        });
        const newFm = [
            '---',
            'name: hr', 'description: HR (changed)',
            'read: hr-read', 'write: hr-write', 'admin: new-admin',
            '---',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newFm);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', restricted, newFm);
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('creating a new workspace requires the principal to hold the declared admin scope', async () => {
        const newWs = [
            '---',
            'name: newthing',
            'description: a new workspace',
            'admin: newthing-admin',
            '---',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/newthing/WORKSPACE.md', newWs);
        const diff = diffAdd('workspaces/newthing/WORKSPACE.md', newWs);

        const denied = makeLintWorkspace({ scopes: new Set([]), email: 'x@bitrefill.com' });
        const fail = await denied({ diff, workspaces: ['newthing'], workingTreeRoot: root });
        const failed = expectErrors(fail);
        expect(failed.errors.some(e => e.code === 'admin_denied')).toBe(true);

        const allowed = makeLintWorkspace({ scopes: new Set(['newthing-admin']), email: 'x@bitrefill.com' });
        const ok = await allowed({ diff, workspaces: ['newthing'], workingTreeRoot: root });
        expect(ok).toEqual({ ok: true });
    });

    it('_platform body is write-protected when write: ernesto:agent-ops is declared', async () => {
        const platform = [
            '---',
            'name: _platform',
            'description: Org-wide guardrails',
            'write: ernesto:agent-ops',
            'admin: ernesto:agent-ops',
            '---',
            '',
            '# Bitrefill Agent Operating Guidelines',
            '',
            'Original body.',
        ].join('\n');
        await seedWorkspace(root, '_platform', platform);
        await commitAll(root, 'seed');

        // Body-only edit by a no-scope principal → write_denied.
        const newBody = platform.replace('Original body.', 'Original body.\n\nInjected rule.');
        await writeStagedFile(root, 'workspaces/_platform/WORKSPACE.md', newBody);
        const diff = diffModify('workspaces/_platform/WORKSPACE.md', platform, newBody);

        const denied = makeLintWorkspace({ scopes: new Set([]), email: 'random@bitrefill.com' });
        const fail = await denied({ diff, workspaces: ['_platform'], workingTreeRoot: root });
        const failed = expectErrors(fail);
        expect(failed.errors.some(e => e.code === 'write_denied' && e.workspace === '_platform')).toBe(true);

        // Same edit with agent-ops → passes.
        const allowed = makeLintWorkspace({ scopes: new Set(['ernesto:agent-ops']), email: 'ops@bitrefill.com' });
        const ok = await allowed({ diff, workspaces: ['_platform'], workingTreeRoot: root });
        expect(ok).toEqual({ ok: true });
    });

    it('bypass: { attachments_hand_edit } skips the rule for privileged settles', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        // Without bypass: any touch is rejected.
        const lint = makeLintWorkspace({
            scopes: new Set(['ernesto:agent-ops']),
            email: 'ops@bitrefill.com',
        });
        await writeStagedFile(root, 'workspaces/hr/attachments.yaml', '- key: abc\n');
        const diff = diffAdd('workspaces/hr/attachments.yaml', '- key: abc\n');
        const blocked = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const blockedFailed = expectErrors(blocked);
        expect(blockedFailed.errors.some(e => e.code === 'attachments_hand_edit')).toBe(true);

        // With bypass: rule is skipped, settle passes.
        const lintBypass = makeLintWorkspace(
            { scopes: new Set(['ernesto:agent-ops']), email: 'ops@bitrefill.com' },
            { bypass: new Set(['attachments_hand_edit']) },
        );
        const ok = await lintBypass({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(ok).toEqual({ ok: true });
    });

    it('changing the admin scope itself requires holding the OLD admin scope', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        const swapAdmin = [
            '---',
            'name: hr', 'description: HR policies and procedures',
            'admin: malicious-admin',
            '---',
            '',
            '# HR', '', 'Body content here.',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', swapAdmin);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, swapAdmin);

        const lint = makeLintWorkspace({ scopes: new Set(['malicious-admin']), email: 'attacker@bitrefill.com' });
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some(e => e.code === 'admin_denied')).toBe(true);
    });
});
