import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { runGit } from '../run-git';
import { settleFromPatch } from '../settle-from-patch';
import { lintWorkspace } from '../../lint/lint-workspace';
import { buildWorkdir as kitBuildWorkdir } from '../../__tests__/kit';

const VALID_HR = ['---', 'name: hr', 'description: HR policies and procedures', 'admin: hr-admin', '---', '', '# HR', ''].join('\n');

/**
 * binary_file via the laptop patch path — the design's non-negotiable twin to
 * the synthetic-diff coverage in lint/__tests__/attachments-lint.test.ts.
 *
 * This pins the load-bearing wiring no synthetic diff exercises: `runSettleCore`
 * builds the lint diff with a plain `git diff --cached` (NO `--binary`), so a
 * staged binary surfaces as a terse "Binary files a/X and b/X differ" stanza —
 * which carries no `--- a/` / `+++ b/` lines. The lint's `parseDiff` therefore
 * recovers `toPath` ONLY from the `diff --git a/X b/Y` header fallback; the
 * binary_file rule then stats/reads that path off disk. A regression in either
 * (lint diff gaining `--binary`, or the header parse) would silently let
 * binaries onto main, so we drive the real `lintWorkspace` end-to-end through a
 * hand-crafted `--binary` patch (the exact wire shape the laptop produces).
 */
describe('settleFromPatch — binary_file rejection through the real lint', () => {
    let tmpRoot: string;
    let built: Awaited<ReturnType<typeof kitBuildWorkdir>>;

    beforeEach(async () => {
        built = await kitBuildWorkdir({ prefix: 'ernesto-patch-binary-', workdirId: 'wd1' });
        tmpRoot = built.root;
    });

    afterEach(async () => {
        await built.cleanup();
    });

    /** Seed `workspaces/hr` (committed), then build a `--binary` patch that adds
     *  a NUL-byte file under it — captured from a sibling clone seeded
     *  identically, exactly as the laptop transport emits it. */
    async function seedAndBuildBinaryPatch(binaryRel: string, bytes: Buffer): Promise<{ patch: string; headSha: string }> {
        await mkdir(path.join(tmpRoot, 'workspaces', 'hr'), { recursive: true });
        await writeFile(path.join(tmpRoot, 'workspaces', 'hr', 'WORKSPACE.md'), VALID_HR);
        await runGit(tmpRoot, ['add', '-A']);
        await runGit(tmpRoot, ['commit', '-q', '-m', 'seed hr']);
        const headSha = (await runGit(tmpRoot, ['rev-parse', 'HEAD'])).trim();

        const stagingDir = await mkdtemp(path.join(tmpdir(), 'ernesto-patch-binary-stage-'));
        await runGit(stagingDir, ['init', '-q', '-b', 'main']);
        await runGit(stagingDir, ['config', 'user.email', 'p@b.com']);
        await runGit(stagingDir, ['config', 'user.name', 'p']);
        await runGit(stagingDir, ['config', 'commit.gpgsign', 'false']);
        await mkdir(path.join(stagingDir, 'workspaces', 'hr'), { recursive: true });
        await writeFile(path.join(stagingDir, 'workspaces', 'hr', 'WORKSPACE.md'), VALID_HR);
        await runGit(stagingDir, ['add', '-A']);
        await runGit(stagingDir, ['commit', '-q', '-m', 'seed hr']);

        const abs = path.join(stagingDir, binaryRel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, bytes);
        await runGit(stagingDir, ['add', binaryRel]);
        // `--binary` is what makes this a GIT binary patch literal git can
        // reconstruct on apply; a plain diff would emit only the unreplayable
        // "Binary files differ" stanza.
        const patch = await runGit(stagingDir, ['diff', '--cached', '--binary']);
        await rm(stagingDir, { recursive: true, force: true });
        return { patch, headSha };
    }

    it('a --binary patch adding a NUL-byte file is rejected with binary_file, no commit', async () => {
        const binaryRel = 'workspaces/hr/logo.png';
        // NUL is valid UTF-8, so this also pins the explicit NUL check the lint
        // does on top of isUtf8.
        const { patch, headSha } = await seedAndBuildBinaryPatch(binaryRel, Buffer.from('PNG\0\0\0binary\0bytes\n'));

        const r = await settleFromPatch(built.workdir, {
            workspaces: ['hr'],
            message: 'attach raw binary by hand',
            patch,
            parentSha: headSha,
            lint: lintWorkspace,
        });

        expect(r.ok).toBe(false);
        if (!r.ok && r.error === 'lint_failed') {
            expect(r.errors.some((e) => e.code === 'binary_file' && e.path === binaryRel)).toBe(true);
        } else {
            throw new Error(`expected lint_failed with binary_file, got ${JSON.stringify(r)}`);
        }

        // The reject must hard-reset the ephemeral tree: nothing committed, no
        // binary left staged.
        const log = await runGit(tmpRoot, ['log', '--format=%s']);
        expect(log).not.toContain('attach raw binary by hand');
        const status = await runGit(tmpRoot, ['status', '--porcelain']);
        expect(status.trim()).toBe('');
    });
});
