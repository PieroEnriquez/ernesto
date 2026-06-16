/**
 * Lint tests for the attachments flip: `attachments.yaml` is a tracked git
 * file (no longer a generated path), gated by the structural
 * `invalid_attachments_yaml` rule; committed files must be plain UTF-8 text
 * (`binary_file`); and the generated-path rule stays in sync with the
 * settle-core lists (`_results/`, `.derived-from-sha`) even for hand-crafted
 * patches that bypass the stage pathspecs.
 *
 * Same harness as lint-workspace.test.ts: each fixture is a real git repo,
 * the post-stage file is written to disk, and the lint is fed a synthetic
 * unified diff matching what `git diff --cached` would emit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { lintWorkspace, lintAttachmentsFile, INVALID_ATTACHMENTS_YAML } from '../lint-workspace';
import { buildWorkdir, seedWorkspace } from '../../__tests__/kit';
import { runGit } from '../../workdir/run-git';

interface FailedLint {
    ok: false;
    errors: ReadonlyArray<{ code: string; workspace?: string; path?: string; message: string }>;
}
function expectErrors(result: { ok: boolean }): FailedLint {
    expect(result.ok).toBe(false);
    return result as unknown as FailedLint;
}

async function commitAll(root: string, msg: string): Promise<void> {
    await runGit(root, ['add', '-A']);
    await runGit(root, ['commit', '-q', '-m', msg]);
}

async function writeStagedFile(root: string, p: string, body: string | Buffer): Promise<void> {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), body);
}

function diffModify(p: string, beforeBody: string, afterBody: string): string {
    const before = beforeBody.split('\n').map((l) => `-${l}`);
    const after = afterBody.split('\n').map((l) => `+${l}`);
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
    const added = body.split('\n').map((l) => `+${l}`);
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
    const removed = body.split('\n').map((l) => `-${l}`);
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

const VALID_RECRUITING = [
    '---',
    'name: recruiting',
    'description: Recruiting pipeline, roles, and sourcing',
    'admin: recruiting-admin',
    '---',
    '',
    '# Recruiting',
].join('\n');

/** A structurally valid attachments.yaml body (timestamps quoted so js-yaml
 *  keeps them strings, matching the canonical serializer's output). */
function validAttachmentsYaml(name: string): string {
    return [
        `- name: ${name}`,
        `  sha256: ${'a'.repeat(64)}`,
        '  bytes: 1234',
        '  mimeType: application/pdf',
        "  attachedAt: '2026-06-11T00:00:00Z'",
        '  attachedBy: piero@bitrefill.com',
        '',
    ].join('\n');
}

/** Entry-level violation: sha256 is not 64 hex chars. */
const INVALID_ATTACHMENTS = [
    '- name: playbook.pdf',
    '  sha256: not-a-sha',
    '  bytes: 1234',
    '  mimeType: application/pdf',
    "  attachedAt: '2026-06-11T00:00:00Z'",
    '  attachedBy: piero@bitrefill.com',
    '',
].join('\n');

describe('attachments.yaml — no longer a generated path', () => {
    let root: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ root, cleanup } = await buildWorkdir({ prefix: 'lint-attach-', gitInit: true }));
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
    });

    afterEach(async () => {
        await cleanup();
    });

    it('adding a valid attachments.yaml passes (no forbidden_generated_path)', async () => {
        const body = validAttachmentsYaml('playbook.pdf');
        await writeStagedFile(root, 'workspaces/hr/attachments.yaml', body);
        const diff = diffAdd('workspaces/hr/attachments.yaml', body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('modifying a committed attachments.yaml passes (no forbidden_generated_path)', async () => {
        const before = validAttachmentsYaml('playbook.pdf');
        await writeStagedFile(root, 'workspaces/hr/attachments.yaml', before);
        await commitAll(root, 'attach playbook');
        const after = validAttachmentsYaml('runbook.pdf');
        await writeStagedFile(root, 'workspaces/hr/attachments.yaml', after);
        const diff = diffModify('workspaces/hr/attachments.yaml', before, after);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('deleting attachments.yaml passes (a workspace may drop its index)', async () => {
        const body = validAttachmentsYaml('playbook.pdf');
        const diff = diffDelete('workspaces/hr/attachments.yaml', body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('flags invalid_attachments_yaml on a structurally invalid index', async () => {
        await writeStagedFile(root, 'workspaces/hr/attachments.yaml', INVALID_ATTACHMENTS);
        const diff = diffAdd('workspaces/hr/attachments.yaml', INVALID_ATTACHMENTS);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some(
                (e) =>
                    e.code === INVALID_ATTACHMENTS_YAML &&
                    e.workspace === 'hr' &&
                    e.path === 'workspaces/hr/attachments.yaml' &&
                    /sha256/.test(e.message),
            ),
        ).toBe(true);
        expect(failed.errors.every((e) => e.code !== 'forbidden_generated_path')).toBe(true);
    });

    it('flags invalid_attachments_yaml on a non-list top level', async () => {
        const mapping = 'name: oops\n';
        await writeStagedFile(root, 'workspaces/hr/attachments.yaml', mapping);
        const diff = diffAdd('workspaces/hr/attachments.yaml', mapping);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === INVALID_ATTACHMENTS_YAML && /list/.test(e.message))).toBe(true);
    });
});

describe('attachments.yaml — nested sub-workspace boundary', () => {
    let root: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ root, cleanup } = await buildWorkdir({ prefix: 'lint-attach-nested-', gitInit: true }));
        // Parent `hr` and a committed sub-workspace `hr/recruiting`.
        await seedWorkspace(root, 'hr', VALID_HR);
        await writeStagedFile(root, 'workspaces/hr/recruiting/WORKSPACE.md', VALID_RECRUITING);
        await commitAll(root, 'seed hr + nested recruiting');
    });

    afterEach(async () => {
        await cleanup();
    });

    it('a valid nested attachments.yaml passes, attributed to the sub-workspace', async () => {
        const body = validAttachmentsYaml('offer-letter.pdf');
        await writeStagedFile(root, 'workspaces/hr/recruiting/attachments.yaml', body);
        const diff = diffAdd('workspaces/hr/recruiting/attachments.yaml', body);
        const result = await lintWorkspace({ diff, workspaces: ['recruiting'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('flags invalid_attachments_yaml at the nested boundary, charged to the sub-workspace', async () => {
        await writeStagedFile(root, 'workspaces/hr/recruiting/attachments.yaml', INVALID_ATTACHMENTS);
        const diff = diffAdd('workspaces/hr/recruiting/attachments.yaml', INVALID_ATTACHMENTS);
        const result = await lintWorkspace({ diff, workspaces: ['recruiting'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some(
                (e) =>
                    e.code === INVALID_ATTACHMENTS_YAML &&
                    e.workspace === 'recruiting' &&
                    e.path === 'workspaces/hr/recruiting/attachments.yaml',
            ),
        ).toBe(true);
        expect(failed.errors.every((e) => e.code !== 'forbidden_generated_path')).toBe(true);
    });
});

describe('binary_file — committed files must be plain UTF-8 text', () => {
    let root: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ root, cleanup } = await buildWorkdir({ prefix: 'lint-binary-', gitInit: true }));
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
    });

    afterEach(async () => {
        await cleanup();
    });

    it('flags binary_file on an ASCII file containing a NUL byte', async () => {
        // NUL is valid UTF-8, so this pins the explicit NUL check.
        await writeStagedFile(root, 'workspaces/hr/blob.dat', Buffer.from('hello\0world\n'));
        const diff = diffAdd('workspaces/hr/blob.dat', '');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some(
                (e) => e.code === 'binary_file' && e.workspace === 'hr' && e.path === 'workspaces/hr/blob.dat' && /attach/.test(e.message),
            ),
        ).toBe(true);
    });

    it('flags binary_file on invalid UTF-8 with no NUL bytes', async () => {
        // 0xff never appears in well-formed UTF-8 — pins the isUtf8 branch.
        await writeStagedFile(root, 'workspaces/hr/latin1.txt', Buffer.from([0x68, 0x69, 0x20, 0xff, 0x0a]));
        const diff = diffAdd('workspaces/hr/latin1.txt', '');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'binary_file' && e.path === 'workspaces/hr/latin1.txt')).toBe(true);
    });

    it('passes multi-byte UTF-8 text (emoji)', async () => {
        const body = '# Launch notes 🎉\n\nДобре дошли — 日本語もOK.\n';
        await writeStagedFile(root, 'workspaces/hr/notes.md', body);
        const diff = diffAdd('workspaces/hr/notes.md', body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });
});

describe('forbidden_generated_path — list sync with settle-core', () => {
    let root: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ root, cleanup } = await buildWorkdir({ prefix: 'lint-gen-sync-', gitInit: true }));
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
    });

    afterEach(async () => {
        await cleanup();
    });

    // The stage pathspecs exclude these, but a hand-crafted patch through
    // settleFromPatch can name any path (`apply --index` ignores .gitignore
    // for new files) — the lint is the gate that holds.
    it('flags _results/ entries in a hand-crafted patch', async () => {
        const diff = diffAdd('workspaces/hr/_results/run-1/output.md', '# derived output\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some(
                (e) => e.code === 'forbidden_generated_path' && e.workspace === 'hr' && e.path === 'workspaces/hr/_results/run-1/output.md',
            ),
        ).toBe(true);
    });

    it('flags .derived-from-sha entries in a hand-crafted patch', async () => {
        const diff = diffAdd('workspaces/hr/.derived-from-sha', 'abc123\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some(
                (e) => e.code === 'forbidden_generated_path' && e.workspace === 'hr' && e.path === 'workspaces/hr/.derived-from-sha',
            ),
        ).toBe(true);
    });
});

describe('lintAttachmentsFile — standalone helper', () => {
    it('returns no errors for a valid body and one INVALID_ATTACHMENTS_YAML per issue otherwise', () => {
        expect(lintAttachmentsFile('workspaces/hr/attachments.yaml', validAttachmentsYaml('playbook.pdf'))).toEqual([]);

        const errors = lintAttachmentsFile('workspaces/hr/attachments.yaml', INVALID_ATTACHMENTS);
        expect(errors.length).toBe(1);
        expect(errors[0].code).toBe(INVALID_ATTACHMENTS_YAML);
        expect(errors[0].workspace).toBe('hr');
        expect(errors[0].path).toBe('workspaces/hr/attachments.yaml');
        expect(errors[0].message).toContain('entry 0');
    });
});
