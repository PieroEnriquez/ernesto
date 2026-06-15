/**
 * Unit tests for `lintWorkspace` and `makeLintWorkspace`.
 *
 * Each fixture is a real git repo so `git show HEAD:...` (used for the
 * old-vs-new frontmatter comparison) returns the committed state. The
 * test then writes the post-stage file to disk and feeds the lint a
 * synthetic unified diff matching what `git diff --cached` would emit.
 *
 * Repo scaffolding (git init + empty commit, `seedWorkspace`) comes from the
 * shared lib test kit; this file owns the parametrized fixtures below.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { lintWorkspace, makeLintWorkspace, UNREGISTERED_EXTRACTION_SOURCE } from '../lint-workspace';
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

async function writeStagedFile(root: string, p: string, body: string): Promise<void> {
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

describe('lintWorkspace (scope-less)', () => {
    let root: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ root, cleanup } = await buildWorkdir({ prefix: 'lint-ws-', gitInit: true }));
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
    });

    afterEach(async () => {
        await cleanup();
    });

    it('passes a happy-path edit inside a declared workspace', async () => {
        await writeStagedFile(root, 'workspaces/hr/leave-policy.md', '# Leave Policy\n');
        const diff = diffAdd('workspaces/hr/leave-policy.md', '# Leave Policy\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    // ── single-code flag fixtures (one staged setup → one expected code) ──────
    //
    // Each row prepares a working tree + synthetic diff and asserts the failing
    // code, preserving the path/workspace sub-assertions each block carried.
    interface FlagCase {
        name: string;
        // Stages files and returns the diff to lint (workspaces always ['hr']).
        setup: () => Promise<string>;
        check: (errors: FailedLint['errors']) => void;
    }

    const flagCases: ReadonlyArray<FlagCase> = [
        {
            name: 'flags out_of_scope_path for files outside any declared workspace',
            setup: async () => diffAdd('README.md', '# repo readme\n'),
            check: (errors) => expect(errors.some((e) => e.code === 'out_of_scope_path' && e.path === 'README.md')).toBe(true),
        },
        {
            name: 'flags missing_frontmatter on a new WORKSPACE.md without YAML',
            setup: async () => {
                const noFm = '# HR\n\nNo frontmatter here.\n';
                await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', noFm);
                return diffAdd('workspaces/hr/WORKSPACE.md', noFm);
            },
            check: (errors) => expect(errors.some((e) => e.code === 'missing_frontmatter' && e.workspace === 'hr')).toBe(true),
        },
        {
            name: 'flags forbidden_generated_path under extracted/ or attached/',
            setup: async () => diffAdd('workspaces/hr/extracted/sheet.md', '# y\n') + diffAdd('workspaces/hr/attached/note.txt', 'x\n'),
            check: (errors) => {
                const paths = errors.filter((e) => e.code === 'forbidden_generated_path').map((e) => e.path);
                expect(paths).toContain('workspaces/hr/extracted/sheet.md');
                expect(paths).toContain('workspaces/hr/attached/note.txt');
            },
        },
        {
            name: 'flags forbidden_workspace_md_delete when WORKSPACE.md is removed',
            setup: async () => diffDelete('workspaces/hr/WORKSPACE.md', VALID_HR),
            check: (errors) => expect(errors.some((e) => e.code === 'forbidden_workspace_md_delete' && e.workspace === 'hr')).toBe(true),
        },
        {
            name: 'allows a WORKSPACE.md delete when the same workspace is re-created elsewhere (relocation)',
            setup: async () =>
                diffDelete('workspaces/cs-scheduler/WORKSPACE.md', VALID_HR) + diffAdd('workspaces/cs/cs-scheduler/WORKSPACE.md', VALID_HR),
            check: (errors) =>
                expect(errors.some((e) => e.code === 'forbidden_workspace_md_delete' && e.workspace === 'cs-scheduler')).toBe(false),
        },
        {
            name: 'flags workspace_md_missing when other files in a workspace exist without WORKSPACE.md',
            setup: async () => {
                await rm(path.join(root, 'workspaces', 'hr', 'WORKSPACE.md'));
                await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
                return diffAdd('workspaces/hr/note.md', '# n\n');
            },
            check: (errors) => expect(errors.some((e) => e.code === 'workspace_md_missing' && e.workspace === 'hr')).toBe(true),
        },
        {
            name: 'flags project_md_missing when a projects/<name>/ has files but no PROJECT.md',
            setup: async () => {
                await writeStagedFile(root, 'workspaces/hr/projects/onboarding/note.md', '# n\n');
                return diffAdd('workspaces/hr/projects/onboarding/note.md', '# n\n');
            },
            check: (errors) => expect(errors.some((e) => e.code === 'project_md_missing' && e.workspace === 'hr')).toBe(true),
        },
        {
            name: 'flags file_too_large when a staged file exceeds 1 MiB',
            setup: async () => {
                const big = 'x'.repeat(1024 * 1024 + 1);
                await writeStagedFile(root, 'workspaces/hr/big.txt', big);
                return diffAdd('workspaces/hr/big.txt', '');
            },
            check: (errors) => expect(errors.some((e) => e.code === 'file_too_large')).toBe(true),
        },
        {
            name: 'flags merge_markers on staged files with unresolved conflict markers',
            setup: async () => {
                const conflicted = ['# notes', '', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> origin/main', ''].join('\n');
                await writeStagedFile(root, 'workspaces/hr/notes.md', conflicted);
                return diffAdd('workspaces/hr/notes.md', conflicted);
            },
            check: (errors) => expect(errors.some((e) => e.code === 'merge_markers')).toBe(true),
        },
    ];

    it.each(flagCases)('$name', async ({ setup, check }) => {
        const diff = await setup();
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        check(failed.errors);
    });

    it('flags invalid_frontmatter when name does not match dir', async () => {
        const body = ['---', 'name: not-hr', 'description: HR', 'admin: hr-admin', '---'].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', body);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some((e) => e.code === 'invalid_frontmatter' && e.workspace === 'hr' && /does not match/.test(e.message)),
        ).toBe(true);
    });

    it('flags invalid_frontmatter when admin is missing', async () => {
        const body = ['---', 'name: hr', 'description: HR', '---'].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', body);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'invalid_frontmatter' && e.workspace === 'hr' && /admin/.test(e.message))).toBe(true);
    });

    it('flags forbidden_workspace_name on an underscore-prefixed new workspace', async () => {
        const body = ['---', 'name: _hidden', 'description: x', 'admin: hidden-admin', '---'].join('\n');
        await writeStagedFile(root, 'workspaces/_hidden/WORKSPACE.md', body);
        const diff = diffAdd('workspaces/_hidden/WORKSPACE.md', body);
        const result = await lintWorkspace({ diff, workspaces: ['_hidden'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'forbidden_workspace_name' && e.workspace === '_hidden')).toBe(true);
    });

    it('flags forbidden_workspace_name on a name that fails the regex', async () => {
        const body = ['---', 'name: BadName', 'description: x', 'admin: bad-admin', '---'].join('\n');
        await writeStagedFile(root, 'workspaces/BadName/WORKSPACE.md', body);
        const diff = diffAdd('workspaces/BadName/WORKSPACE.md', body);
        const result = await lintWorkspace({ diff, workspaces: ['BadName'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'forbidden_workspace_name')).toBe(true);
    });

    // ── NEGATIVE: workspace-name 40-char length cap ({0,39} quantifier) ───────
    //
    // The existing positive test above only exercises the *case* rule (uppercase
    // 'BadName'); it never touches the LENGTH boundary. WORKSPACE_NAME_REGEX is
    // /^[a-z][a-z0-9-]{0,39}$/ → 1 leading + up to 39 tail = 40 chars inclusive.
    // We pin both sides of the off-by-one: 41 chars must be rejected, 40 must
    // pass. This catches a future widening of the cap OR an off-by-one in the
    // {0,39} quantifier.
    it('rejects a 41-char new-workspace leaf name (over the {0,39} length cap)', async () => {
        const name = 'a'.repeat(41);
        const body = ['---', `name: ${name}`, 'description: x', `admin: ${name}-admin`, '---'].join('\n');
        await writeStagedFile(root, `workspaces/${name}/WORKSPACE.md`, body);
        const diff = diffAdd(`workspaces/${name}/WORKSPACE.md`, body);
        const result = await lintWorkspace({ diff, workspaces: [name], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'forbidden_workspace_name' && e.workspace === name)).toBe(true);
    });

    it('accepts a 40-char new-workspace leaf name (the cap is inclusive at 40)', async () => {
        const name = 'a'.repeat(40);
        const body = ['---', `name: ${name}`, 'description: x', `admin: ${name}-admin`, '---'].join('\n');
        await writeStagedFile(root, `workspaces/${name}/WORKSPACE.md`, body);
        const diff = diffAdd(`workspaces/${name}/WORKSPACE.md`, body);
        const result = await lintWorkspace({ diff, workspaces: [name], workingTreeRoot: root });
        // The boundary value must NOT trip forbidden_workspace_name. (Other
        // unrelated codes are irrelevant; pin only the name rule.)
        if (!result.ok) {
            expect((result as FailedLint).errors.every((e) => e.code !== 'forbidden_workspace_name')).toBe(true);
        } else {
            expect(result).toEqual({ ok: true });
        }
    });

    // ── NEGATIVE: 1 MiB file cap is strict `>` (boundary inclusive at the cap) ─
    //
    // The existing flagCase only tests the OVER-cap case (1 MiB + 1). The cap
    // boundary itself is unpinned. A file of EXACTLY MAX_FILE_BYTES must PASS
    // (the guard is `st.size > MAX_FILE_BYTES`), and +1 byte must flag. This
    // pins the strict `>` so a future `>=` (fail-CLOSED) regression or a relaxed
    // cap is caught.
    it('accepts a file of exactly 1 MiB (the cap is strict `>`, inclusive at MAX_FILE_BYTES)', async () => {
        const exact = 'x'.repeat(1024 * 1024);
        await writeStagedFile(root, 'workspaces/hr/exact.txt', exact);
        const diff = diffAdd('workspaces/hr/exact.txt', '');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        if (!result.ok) {
            expect((result as FailedLint).errors.some((e) => e.code === 'file_too_large')).toBe(false);
        } else {
            expect(result).toEqual({ ok: true });
        }
    });

    it('flags file_too_large at exactly 1 MiB + 1 byte (companion to the boundary)', async () => {
        const over = 'x'.repeat(1024 * 1024 + 1);
        await writeStagedFile(root, 'workspaces/hr/over.txt', over);
        const diff = diffAdd('workspaces/hr/over.txt', '');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'file_too_large' && e.path === 'workspaces/hr/over.txt')).toBe(true);
    });

    // ── NEGATIVE: cross-workspace move into UNDECLARED scope is rejected ───────
    //
    // The existing flagCase tests the ALLOW side (same-leaf WORKSPACE.md
    // relocation). The REJECT side — moving content into a workspace NOT in the
    // declared set — is untested. The relocation carve-out is ONLY for a
    // same-leaf WORKSPACE.md re-create; moving a plain file into an undeclared
    // boundary must still raise out_of_scope_path for the destination.
    it('rejects a cross-workspace move whose destination is outside declared scope', async () => {
        // `finance` is a real committed boundary, but the settle declares only
        // ['hr'] — so the move's destination resolves to a workspace not in scope.
        await seedWorkspace(root, 'finance', VALID_HR.replace(/name: hr/, 'name: finance').replace(/admin: hr-admin/, 'admin: finance-admin'));
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        await commitAll(root, 'seed finance + hr note');
        // Move workspaces/hr/note.md -> workspaces/finance/note.md.
        await rm(path.join(root, 'workspaces', 'hr', 'note.md'));
        await writeStagedFile(root, 'workspaces/finance/note.md', '# n\n');
        const diff = diffDelete('workspaces/hr/note.md', '# n\n') + diffAdd('workspaces/finance/note.md', '# n\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some((e) => e.code === 'out_of_scope_path' && e.path === 'workspaces/finance/note.md'),
        ).toBe(true);
    });

    // ── NEGATIVE: leaf-RENAMING WORKSPACE.md move does NOT satisfy the carve-out ─
    //
    // The relocation carve-out keys on the SAME leaf name being re-created. A
    // move that RENAMES the leaf (cs-scheduler -> scheduler) orphans the old
    // contract: forbidden_workspace_md_delete must STILL fire for 'cs-scheduler'.
    // This guards lint-workspace.ts:557-576 against over-granting on a
    // leaf-changing rename.
    it('still flags forbidden_workspace_md_delete when a WORKSPACE.md move RENAMES the leaf', async () => {
        const diff =
            diffDelete('workspaces/cs-scheduler/WORKSPACE.md', VALID_HR) +
            diffAdd('workspaces/cs/scheduler/WORKSPACE.md', VALID_HR);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some((e) => e.code === 'forbidden_workspace_md_delete' && e.workspace === 'cs-scheduler'),
        ).toBe(true);
    });

    // ── NEGATIVE: prose edit cannot ride along on a valid unarchive flip ───────
    //
    // The existing :245/:278 tests cover (a) prose write to an archived ws and
    // (b) WORKSPACE.md edit without unarchive. The uncovered case: a diff that
    // BOTH flips archived:true->false AND edits a prose file in the same
    // archived workspace. The unarchive carve-out requires `onlyWorkspaceMd`, so
    // a bundled prose edit must NOT be smuggled in under the unarchive flip.
    it('blocks a prose edit bundled with a valid unarchive flip (carve-out requires WORKSPACE.md-only)', async () => {
        const before = ['---', 'name: hr', 'description: HR', 'admin: hr-admin', 'archived: true', '---', ''].join('\n');
        const after = ['---', 'name: hr', 'description: HR', 'admin: hr-admin', 'archived: false', '---', ''].join('\n');
        await seedWorkspace(root, 'hr', before);
        await commitAll(root, 'archived seed');
        // Valid unarchive flip on WORKSPACE.md...
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', after);
        // ...BUNDLED with a prose edit in the same (HEAD-archived) workspace.
        await writeStagedFile(root, 'workspaces/hr/note.md', '# smuggled\n');
        const diff =
            diffModify('workspaces/hr/WORKSPACE.md', before, after) + diffAdd('workspaces/hr/note.md', '# smuggled\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'archived_workspace_edit' && e.workspace === 'hr')).toBe(true);
    });

    it('flags archived_workspace_edit on writes to an archived workspace', async () => {
        const archived = ['---', 'name: hr', 'description: HR', 'admin: hr-admin', 'archived: true', '---'].join('\n');
        await seedWorkspace(root, 'hr', archived);
        await commitAll(root, 'archive');
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'archived_workspace_edit' && e.workspace === 'hr')).toBe(true);
    });

    it('allows the archive transition (not archived at HEAD -> archived: true)', async () => {
        const before = ['---', 'name: hr', 'description: HR', 'admin: hr-admin', '---', ''].join('\n');
        const after = ['---', 'name: hr', 'description: HR', 'admin: hr-admin', 'archived: true', '---', ''].join('\n');
        await seedWorkspace(root, 'hr', before);
        await commitAll(root, 'seed');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', after);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', before, after);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result.ok).toBe(true);
    });

    it('allows the unarchive flip (archived: true -> archived: false, WORKSPACE.md only)', async () => {
        const before = ['---', 'name: hr', 'description: HR', 'admin: hr-admin', 'archived: true', '---', ''].join('\n');
        const after = ['---', 'name: hr', 'description: HR', 'admin: hr-admin', 'archived: false', '---', ''].join('\n');
        await seedWorkspace(root, 'hr', before);
        await commitAll(root, 'archived seed');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', after);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', before, after);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result.ok).toBe(true);
    });

    it('blocks editing an archived workspace WORKSPACE.md without unarchiving', async () => {
        const before = ['---', 'name: hr', 'description: HR', 'admin: hr-admin', 'archived: true', '---', ''].join('\n');
        const after = ['---', 'name: hr', 'description: HR (updated)', 'admin: hr-admin', 'archived: true', '---', ''].join('\n');
        await seedWorkspace(root, 'hr', before);
        await commitAll(root, 'archived seed');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', after);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', before, after);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'archived_workspace_edit' && e.workspace === 'hr')).toBe(true);
    });

    it('allows a projects/<name>/ that includes a PROJECT.md', async () => {
        await writeStagedFile(root, 'workspaces/hr/projects/onboarding/PROJECT.md', '# Onboarding\n');
        await writeStagedFile(root, 'workspaces/hr/projects/onboarding/note.md', '# n\n');
        const diff =
            diffAdd('workspaces/hr/projects/onboarding/PROJECT.md', '# Onboarding\n') +
            diffAdd('workspaces/hr/projects/onboarding/note.md', '# n\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result.ok).toBe(true);
    });

    it('does not flag project_md_missing for a settle that never touches projects/', async () => {
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result.ok).toBe(true);
    });

    it('does not flag merge_markers on prose using ======= as a thematic break', async () => {
        const benign = ['# title', '', 'Some intro.', '', '=======', '', 'Section after.', ''].join('\n');
        await writeStagedFile(root, 'workspaces/hr/notes.md', benign);
        const diff = diffAdd('workspaces/hr/notes.md', benign);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });
});

describe('makeLintWorkspace(principal) — read/write/admin scopes', () => {
    let root: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ root, cleanup } = await buildWorkdir({ prefix: 'lint-ws-p-', gitInit: true }));
    });

    afterEach(async () => {
        await cleanup();
    });

    it('public-default workspace: any principal can write prose', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({ scopes: new Set([]), email: 'random@example.com' });
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('read_denied when read scope set and principal lacks it', async () => {
        const restricted = ['---', 'name: hr', 'description: HR', 'read: hr-read', 'write: hr-write', 'admin: hr-admin', '---'].join('\n');
        await seedWorkspace(root, 'hr', restricted);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({ scopes: new Set(['payments:read']), email: 'x@example.com' });
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'read_denied' && e.workspace === 'hr')).toBe(true);
    });

    it('write_denied when read passes but write scope is missing', async () => {
        const restricted = ['---', 'name: hr', 'description: HR', 'read: hr-read', 'write: hr-write', 'admin: hr-admin', '---'].join('\n');
        await seedWorkspace(root, 'hr', restricted);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({ scopes: new Set(['hr-read']), email: 'x@example.com' });
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'write_denied')).toBe(true);
    });

    it('write scope passes prose edits', async () => {
        const restricted = ['---', 'name: hr', 'description: HR', 'read: hr-read', 'write: hr-write', 'admin: hr-admin', '---'].join('\n');
        await seedWorkspace(root, 'hr', restricted);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({ scopes: new Set(['hr-write']), email: 'x@example.com' });
        await writeStagedFile(root, 'workspaces/hr/note.md', '# n\n');
        const diff = diffAdd('workspaces/hr/note.md', '# n\n');
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('admin_denied when modifying WORKSPACE.md frontmatter without admin', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        const newFm = ['---', 'name: hr', 'description: HR (rephrased)', 'admin: hr-admin', '---'].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newFm);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, newFm);
        const lint = makeLintWorkspace({ scopes: new Set([]), email: 'x@example.com' });
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'admin_denied')).toBe(true);
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
        const lint = makeLintWorkspace({ scopes: new Set([]), email: 'x@example.com' });
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('admin scope satisfies frontmatter changes', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        const newFm = ['---', 'name: hr', 'description: HR (rephrased)', 'admin: hr-admin', '---'].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newFm);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, newFm);
        const lint = makeLintWorkspace({ scopes: new Set(['hr-admin']), email: 'x@example.com' });
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('ernesto:agent-ops bypasses everything', async () => {
        const restricted = ['---', 'name: hr', 'description: HR', 'read: hr-read', 'write: hr-write', 'admin: hr-admin', '---'].join('\n');
        await seedWorkspace(root, 'hr', restricted);
        await commitAll(root, 'seed');
        const lint = makeLintWorkspace({
            scopes: new Set(['ernesto:agent-ops']),
            email: 'ops@example.com',
        });
        const newFm = ['---', 'name: hr', 'description: HR (changed)', 'read: hr-read', 'write: hr-write', 'admin: new-admin', '---'].join(
            '\n',
        );
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newFm);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', restricted, newFm);
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('creating a new workspace requires the principal to hold the declared admin scope', async () => {
        const newWs = ['---', 'name: newthing', 'description: a new workspace', 'admin: newthing-admin', '---'].join('\n');
        await writeStagedFile(root, 'workspaces/newthing/WORKSPACE.md', newWs);
        const diff = diffAdd('workspaces/newthing/WORKSPACE.md', newWs);

        const denied = makeLintWorkspace({ scopes: new Set([]), email: 'x@example.com' });
        const fail = await denied({ diff, workspaces: ['newthing'], workingTreeRoot: root });
        const failed = expectErrors(fail);
        expect(failed.errors.some((e) => e.code === 'admin_denied')).toBe(true);

        const allowed = makeLintWorkspace({ scopes: new Set(['newthing-admin']), email: 'x@example.com' });
        const ok = await allowed({ diff, workspaces: ['newthing'], workingTreeRoot: root });
        expect(ok).toEqual({ ok: true });
    });

    it('_ernesto body is write-protected when write: ernesto:agent-ops is declared', async () => {
        const platform = [
            '---',
            'name: _ernesto',
            'description: Org-wide guardrails',
            'write: ernesto:agent-ops',
            'admin: ernesto:agent-ops',
            '---',
            '',
            '# Agent Operating Guidelines',
            '',
            'Original body.',
        ].join('\n');
        await seedWorkspace(root, '_ernesto', platform);
        await commitAll(root, 'seed');

        // Body-only edit by a no-scope principal → write_denied.
        const newBody = platform.replace('Original body.', 'Original body.\n\nInjected rule.');
        await writeStagedFile(root, 'workspaces/_ernesto/WORKSPACE.md', newBody);
        const diff = diffModify('workspaces/_ernesto/WORKSPACE.md', platform, newBody);

        const denied = makeLintWorkspace({ scopes: new Set([]), email: 'random@example.com' });
        const fail = await denied({ diff, workspaces: ['_ernesto'], workingTreeRoot: root });
        const failed = expectErrors(fail);
        expect(failed.errors.some((e) => e.code === 'write_denied' && e.workspace === '_ernesto')).toBe(true);

        // Same edit with agent-ops → passes.
        const allowed = makeLintWorkspace({ scopes: new Set(['ernesto:agent-ops']), email: 'ops@example.com' });
        const ok = await allowed({ diff, workspaces: ['_ernesto'], workingTreeRoot: root });
        expect(ok).toEqual({ ok: true });
    });

    it('bypass: { forbidden_generated_path } skips the rule for derive-worker settles', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');

        const sheetBody = '# Sheet\n\nrow\n';
        const noteBody = 'inline note\n';
        await writeStagedFile(root, 'workspaces/hr/extracted/sheet.md', sheetBody);
        await writeStagedFile(root, 'workspaces/hr/attached/note.txt', noteBody);
        const diff = diffAdd('workspaces/hr/extracted/sheet.md', sheetBody) + diffAdd('workspaces/hr/attached/note.txt', noteBody);

        // Without bypass: both files are rejected.
        const blocked = await makeLintWorkspace({
            scopes: new Set(['ernesto:agent-ops']),
            email: 'ops@example.com',
        })({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const blockedFailed = expectErrors(blocked);
        const blockedPaths = blockedFailed.errors.filter((e) => e.code === 'forbidden_generated_path').map((e) => e.path);
        expect(blockedPaths).toContain('workspaces/hr/extracted/sheet.md');
        expect(blockedPaths).toContain('workspaces/hr/attached/note.txt');

        // With bypass: rule is skipped, settle passes.
        const lintBypass = makeLintWorkspace(
            { scopes: new Set(['ernesto:agent-ops']), email: 'ops@example.com' },
            { bypass: new Set(['forbidden_generated_path']) },
        );
        const ok = await lintBypass({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(ok).toEqual({ ok: true });
    });

    it('changing the admin scope itself requires holding the OLD admin scope', async () => {
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
        const swapAdmin = [
            '---',
            'name: hr',
            'description: HR policies and procedures',
            'admin: malicious-admin',
            '---',
            '',
            '# HR',
            '',
            'Body content here.',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', swapAdmin);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, swapAdmin);

        const lint = makeLintWorkspace({ scopes: new Set(['malicious-admin']), email: 'attacker@example.com' });
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'admin_denied')).toBe(true);
    });
});

describe('unregistered_extraction_source — registry-driven validation', () => {
    let root: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ root, cleanup } = await buildWorkdir({ prefix: 'lint-ws-ext-', gitInit: true }));
    });

    afterEach(async () => {
        await cleanup();
    });

    function makeMd(name: string, extractions: ReadonlyArray<{ source: string; target: string }>): string {
        const lines = ['---', `name: ${name}`, `description: ${name} workspace`, `admin: ${name}-admin`];
        if (extractions.length > 0) {
            lines.push('extractions:');
            for (const e of extractions) {
                lines.push(`  - source: ${e.source}`);
                lines.push(`    target: ${e.target}`);
            }
        }
        lines.push('---', '', `# ${name}`);
        return lines.join('\n');
    }

    it('passes when every declared source is registered', async () => {
        const body = makeMd('hr', [{ source: 'clickup', target: 'team-handbook' }]);
        await seedWorkspace(root, 'hr', body);
        await commitAll(root, 'seed');

        const newBody = makeMd('hr', [
            { source: 'clickup', target: 'team-handbook' },
            { source: 'github', target: 'acme/backend' },
        ]);
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newBody);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', body, newBody);

        const lint = makeLintWorkspace(
            { scopes: new Set(['ernesto:agent-ops']), email: 'ops@example.com' },
            { getRegisteredSources: () => new Set(['clickup', 'github', 'slack']) },
        );
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('flags unregistered_extraction_source when a source is not registered', async () => {
        const body = makeMd('hr', []);
        await seedWorkspace(root, 'hr', body);
        await commitAll(root, 'seed');

        const newBody = makeMd('hr', [
            { source: 'clickup', target: 'team-handbook' },
            { source: 'mystery-source', target: 'whatever' },
        ]);
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newBody);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', body, newBody);

        const lint = makeLintWorkspace(
            { scopes: new Set(['ernesto:agent-ops']), email: 'ops@example.com' },
            { getRegisteredSources: () => new Set(['clickup', 'github']) },
        );
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        const ext = failed.errors.filter((e) => e.code === UNREGISTERED_EXTRACTION_SOURCE);
        expect(ext.length).toBe(1);
        expect(ext[0].workspace).toBe('hr');
        expect(ext[0].message).toContain('mystery-source');
    });

    it('emits one error per unregistered entry when multiple bad sources are listed', async () => {
        const body = makeMd('hr', []);
        await seedWorkspace(root, 'hr', body);
        await commitAll(root, 'seed');

        const newBody = makeMd('hr', [
            { source: 'mystery-a', target: 'x' },
            { source: 'mystery-b', target: 'y' },
        ]);
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newBody);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', body, newBody);

        const lint = makeLintWorkspace(
            { scopes: new Set(['ernesto:agent-ops']), email: 'ops@example.com' },
            { getRegisteredSources: () => new Set(['clickup']) },
        );
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        const bad = failed.errors.filter((e) => e.code === UNREGISTERED_EXTRACTION_SOURCE);
        expect(bad.map((e) => e.message)).toEqual([expect.stringContaining('mystery-a'), expect.stringContaining('mystery-b')]);
    });

    it('is skipped entirely when getRegisteredSources is not wired', async () => {
        const body = makeMd('hr', []);
        await seedWorkspace(root, 'hr', body);
        await commitAll(root, 'seed');

        const newBody = makeMd('hr', [{ source: 'anything-goes', target: 'x' }]);
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newBody);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', body, newBody);

        // Default scope-less lintWorkspace has no registry → no extraction check.
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('is bypassable via bypass: { unregistered_extraction_source }', async () => {
        const body = makeMd('hr', []);
        await seedWorkspace(root, 'hr', body);
        await commitAll(root, 'seed');

        const newBody = makeMd('hr', [{ source: 'mystery', target: 'x' }]);
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newBody);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', body, newBody);

        const lint = makeLintWorkspace(
            { scopes: new Set(['ernesto:agent-ops']), email: 'ops@example.com' },
            {
                getRegisteredSources: () => new Set(['clickup']),
                bypass: new Set([UNREGISTERED_EXTRACTION_SOURCE]),
            },
        );
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('ignores malformed extractions entries silently (handled by frontmatter shape rules)', async () => {
        // entry missing `source` field → skipped, not flagged here.
        const body = makeMd('hr', []);
        await seedWorkspace(root, 'hr', body);
        await commitAll(root, 'seed');

        const newBody = [
            '---',
            'name: hr',
            'description: hr',
            'admin: hr-admin',
            'extractions:',
            '  - target: only-target',
            '---',
            '',
            '# hr',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', newBody);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', body, newBody);

        const lint = makeLintWorkspace(
            { scopes: new Set(['ernesto:agent-ops']), email: 'ops@example.com' },
            { getRegisteredSources: () => new Set(['clickup']) },
        );
        const result = await lint({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });
});

describe('navigation frontmatter — section / order / title', () => {
    let root: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ root, cleanup } = await buildWorkdir({ prefix: 'lint-ws-nav-', gitInit: true }));
        await seedWorkspace(root, 'hr', VALID_HR);
        await commitAll(root, 'seed');
    });

    afterEach(async () => {
        await cleanup();
    });

    /** WORKSPACE.md body declaring an ordered `sections:` list. */
    function hrWithSections(sectionsYaml: string): string {
        return ['---', 'name: hr', 'description: HR policies and procedures', 'admin: hr-admin', sectionsYaml, '---', '', '# HR'].join(
            '\n',
        );
    }

    function contentFile(fmLines: string[]): string {
        return ['---', ...fmLines, '---', '', '# A doc', ''].join('\n');
    }

    async function lintContent(p: string, body: string) {
        await writeStagedFile(root, p, body);
        const diff = diffAdd(p, body);
        return lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
    }

    it('passes a content file with well-typed section/order/title', async () => {
        const body = contentFile(['section: Policies', 'order: 2', 'title: Leave Policy']);
        const result = await lintContent('workspaces/hr/leave.md', body);
        expect(result).toEqual({ ok: true });
    });

    it('passes a content file with no frontmatter at all', async () => {
        const result = await lintContent('workspaces/hr/plain.md', '# Plain\n');
        expect(result).toEqual({ ok: true });
    });

    // ── invalid nav-frontmatter shape (one content file → invalid_nav_frontmatter) ─
    //
    // (label, fmLines, fileName, fieldRegex): each row stages a content file
    // whose nav frontmatter is wrong-typed and asserts the field-named error.
    const navShapeCases: ReadonlyArray<[string, string[], string, RegExp]> = [
        ['section is not a string', ['section:', '  - nested', '  - list'], 'workspaces/hr/bad-section.md', /section/],
        ['section is an empty string', ['section: "   "', 'title: x'], 'workspaces/hr/empty-section.md', /section/],
        ['order is not a number', ['order: first'], 'workspaces/hr/bad-order.md', /order/],
        // YAML parses `title: 123` as a number → wrong type.
        ['title is not a string', ['title: 123', 'order: 1'], 'workspaces/hr/bad-title.md', /title/],
    ];

    it.each(navShapeCases)('flags invalid_nav_frontmatter when %s', async (_label, fmLines, fileName, fieldRegex) => {
        const body = contentFile(fmLines);
        const result = await lintContent(fileName, body);
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'invalid_nav_frontmatter' && e.path === fileName && fieldRegex.test(e.message))).toBe(
            true,
        );
    });

    it('does NOT shape-check nav keys on WORKSPACE.md itself', async () => {
        // A section/order on the contract file is not a content-nav key.
        const wsBody = [
            '---',
            'name: hr',
            'description: HR policies and procedures',
            'admin: hr-admin',
            'order: not-a-number',
            '---',
            '',
            '# HR',
        ].join('\n');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', wsBody);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, wsBody);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        // No invalid_nav_frontmatter for WORKSPACE.md.
        if (!result.ok) {
            expect((result as FailedLint).errors.every((e) => e.code !== 'invalid_nav_frontmatter')).toBe(true);
        } else {
            expect(result).toEqual({ ok: true });
        }
    });

    it('passes when section is one of WORKSPACE.md declared sections', async () => {
        const ws = hrWithSections('sections: [Policies, Benefits]');
        await seedWorkspace(root, 'hr', ws);
        await commitAll(root, 'add sections');
        const body = contentFile(['section: Benefits']);
        const result = await lintContent('workspaces/hr/benefits.md', body);
        expect(result).toEqual({ ok: true });
    });

    it('flags unknown_section when section is not in declared sections', async () => {
        const ws = hrWithSections('sections: [Policies, Benefits]');
        await seedWorkspace(root, 'hr', ws);
        await commitAll(root, 'add sections');
        const body = contentFile(['section: Onboarding']);
        const result = await lintContent('workspaces/hr/onb.md', body);
        const failed = expectErrors(result);
        const err = failed.errors.find((e) => e.code === 'unknown_section');
        expect(err).toBeDefined();
        expect(err!.workspace).toBe('hr');
        expect(err!.path).toBe('workspaces/hr/onb.md');
        expect(err!.message).toContain('Onboarding');
    });

    it('skips the unknown_section check when WORKSPACE.md declares no sections', async () => {
        // Seeded VALID_HR has no sections: → any section value is allowed.
        const body = contentFile(['section: Anything']);
        const result = await lintContent('workspaces/hr/free.md', body);
        expect(result).toEqual({ ok: true });
    });

    it('flags invalid_workspace_sections when sections is not an array', async () => {
        const ws = hrWithSections('sections: Policies');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', ws);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, ws);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'invalid_workspace_sections' && e.workspace === 'hr')).toBe(true);
    });

    it('flags invalid_workspace_sections when sections is an array of non-strings', async () => {
        const ws = hrWithSections('sections: [1, 2, 3]');
        await writeStagedFile(root, 'workspaces/hr/WORKSPACE.md', ws);
        const diff = diffModify('workspaces/hr/WORKSPACE.md', VALID_HR, ws);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'invalid_workspace_sections')).toBe(true);
    });

    it('does not fire unknown_section when sections is malformed (only invalid_workspace_sections)', async () => {
        // Malformed declared list → yields no usable set → unknown_section skipped.
        const ws = hrWithSections('sections: Policies');
        await seedWorkspace(root, 'hr', ws);
        await commitAll(root, 'bad sections');
        const body = contentFile(['section: Whatever']);
        const result = await lintContent('workspaces/hr/x.md', body);
        // The content file add alone doesn't touch WORKSPACE.md, so
        // invalid_workspace_sections won't fire here; the key point is that
        // unknown_section must NOT fire off a malformed declared list.
        if (!result.ok) {
            expect((result as FailedLint).errors.every((e) => e.code !== 'unknown_section')).toBe(true);
        } else {
            expect(result).toEqual({ ok: true });
        }
    });

    it('ignores nav frontmatter under generated dirs (extracted/, attached/)', async () => {
        const ws = hrWithSections('sections: [Policies]');
        await seedWorkspace(root, 'hr', ws);
        await commitAll(root, 'sections');
        const body = contentFile(['section: NotDeclared', 'order: bad']);
        await writeStagedFile(root, 'workspaces/hr/extracted/doc.md', body);
        const diff = diffAdd('workspaces/hr/extracted/doc.md', body);
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        // It will fail on forbidden_generated_path, but NOT on nav rules.
        expect(failed.errors.every((e) => e.code !== 'invalid_nav_frontmatter' && e.code !== 'unknown_section')).toBe(true);
    });

    it('also validates .mdx content files', async () => {
        const ws = hrWithSections('sections: [Policies]');
        await seedWorkspace(root, 'hr', ws);
        await commitAll(root, 'sections');
        const body = contentFile(['section: Ghost']);
        const result = await lintContent('workspaces/hr/page.mdx', body);
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'unknown_section')).toBe(true);
    });
});

// ─── Nested sub-workspaces (workspace-nesting Stage 0) ──────────────────────
//
// A directory under `workspaces/` is a workspace BOUNDARY iff it carries a
// `WORKSPACE.md`, at any depth. Nesting is a *location* change, not an
// *identity* change: a sub-workspace's `name` is its LEAF segment (globally
// unique = route scheme = scope prefix), and its files are attributed to it,
// not to its enclosing parent. These tests pin that behavior; the flat-layout
// tests above pin that nothing changed when no nested boundary exists.

const VALID_RECRUITING = [
    '---',
    'name: recruiting',
    'description: Recruiting pipeline, roles, and sourcing',
    'admin: recruiting-admin',
    '---',
    '',
    '# Recruiting',
].join('\n');

describe('lintWorkspace — nested sub-workspaces', () => {
    let root: string;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
        ({ root, cleanup } = await buildWorkdir({ prefix: 'lint-ws-nested-', gitInit: true }));
        // Parent `hr` and a committed sub-workspace `hr/recruiting`.
        await seedWorkspace(root, 'hr', VALID_HR);
        await writeStagedFile(root, 'workspaces/hr/recruiting/WORKSPACE.md', VALID_RECRUITING);
        await commitAll(root, 'seed hr + nested recruiting');
    });

    afterEach(async () => {
        await cleanup();
    });

    it('attributes files under hr/recruiting/ to recruiting (declaring recruiting alone admits them)', async () => {
        await writeStagedFile(root, 'workspaces/hr/recruiting/roles/eng.md', '# Eng role\n');
        const diff = diffAdd('workspaces/hr/recruiting/roles/eng.md', '# Eng role\n');
        const result = await lintWorkspace({ diff, workspaces: ['recruiting'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('charges a nested file to the sub-workspace, not the parent: declaring only the parent is out_of_scope', async () => {
        await writeStagedFile(root, 'workspaces/hr/recruiting/roles/eng.md', '# Eng role\n');
        const diff = diffAdd('workspaces/hr/recruiting/roles/eng.md', '# Eng role\n');
        // Declaring only `hr` must NOT admit a file that belongs to `recruiting`.
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(failed.errors.some((e) => e.code === 'out_of_scope_path' && e.path === 'workspaces/hr/recruiting/roles/eng.md')).toBe(true);
    });

    it('a file directly under the parent (above the nested boundary) still attributes to the parent', async () => {
        await writeStagedFile(root, 'workspaces/hr/leave-policy.md', '# Leave\n');
        const diff = diffAdd('workspaces/hr/leave-policy.md', '# Leave\n');
        const result = await lintWorkspace({ diff, workspaces: ['hr'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it("a nested WORKSPACE.md's name must equal its LEAF segment", async () => {
        // name matches leaf → OK.
        const ok = diffModify('workspaces/hr/recruiting/WORKSPACE.md', VALID_RECRUITING, VALID_RECRUITING + '\n\nmore.\n');
        await writeStagedFile(root, 'workspaces/hr/recruiting/WORKSPACE.md', VALID_RECRUITING + '\n\nmore.\n');
        const okResult = await lintWorkspace({ diff: ok, workspaces: ['recruiting'], workingTreeRoot: root });
        expect(okResult).toEqual({ ok: true });
    });

    it('rejects a nested WORKSPACE.md whose name is the parent path, not the leaf', async () => {
        const wrong = VALID_RECRUITING.replace('name: recruiting', 'name: hr');
        await writeStagedFile(root, 'workspaces/hr/recruiting/WORKSPACE.md', wrong);
        const diff = diffModify('workspaces/hr/recruiting/WORKSPACE.md', VALID_RECRUITING, wrong);
        const result = await lintWorkspace({ diff, workspaces: ['recruiting'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some((e) => e.code === 'invalid_frontmatter' && /does not match directory name 'recruiting'/.test(e.message)),
        ).toBe(true);
    });

    it('validates a freshly-created nested sub-workspace by its leaf name', async () => {
        // New sub-workspace `hr/sourcing` created from scratch.
        const body = VALID_RECRUITING.replace('name: recruiting', 'name: sourcing').replace(
            'admin: recruiting-admin',
            'admin: recruiting-admin',
        );
        await writeStagedFile(root, 'workspaces/hr/sourcing/WORKSPACE.md', body);
        const diff = diffAdd('workspaces/hr/sourcing/WORKSPACE.md', body);
        const result = await lintWorkspace({ diff, workspaces: ['sourcing'], workingTreeRoot: root });
        expect(result).toEqual({ ok: true });
    });

    it('blocks deleting a nested WORKSPACE.md (the sub-workspace contract)', async () => {
        const diff = diffDelete('workspaces/hr/recruiting/WORKSPACE.md', VALID_RECRUITING);
        // After delete the file is gone; the deleted path falls back to the
        // enclosing parent `hr`, so declare both to isolate the delete rule.
        const result = await lintWorkspace({ diff, workspaces: ['hr', 'recruiting'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some(
                (e) =>
                    e.code === 'forbidden_workspace_md_delete' &&
                    e.workspace === 'recruiting' &&
                    e.path === 'workspaces/hr/recruiting/WORKSPACE.md',
            ),
        ).toBe(true);
    });

    it('flags extracted/ under a nested sub-workspace as a generated path', async () => {
        await writeStagedFile(root, 'workspaces/hr/recruiting/extracted/x.md', 'data\n');
        const diff = diffAdd('workspaces/hr/recruiting/extracted/x.md', 'data\n');
        const result = await lintWorkspace({ diff, workspaces: ['recruiting'], workingTreeRoot: root });
        const failed = expectErrors(result);
        expect(
            failed.errors.some(
                (e) =>
                    e.code === 'forbidden_generated_path' &&
                    e.workspace === 'recruiting' &&
                    e.path === 'workspaces/hr/recruiting/extracted/x.md',
            ),
        ).toBe(true);
    });
});
