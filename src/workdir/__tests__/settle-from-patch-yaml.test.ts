import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { runGit } from '../run-git';
import { settleFromPatch } from '../settle-from-patch';
import type { LintFn } from '../settle';
import { buildWorkdir as kitBuildWorkdir } from '../../__tests__/kit';

const allowAllLint: LintFn = async () => ({ ok: true });

const baseYaml = ['- name: handbook.pdf', '  sha256: aa11', '  bytes: 10', '  mimeType: application/pdf', ''].join('\n');
const editedYaml = [
    '- name: handbook.pdf',
    '  sha256: aa11',
    '  bytes: 10',
    '  mimeType: application/pdf',
    '- name: playbook.pdf',
    '  sha256: bb22',
    '  bytes: 20',
    '  mimeType: application/pdf',
    '',
].join('\n');

/**
 * Tracked attachments.yaml round-trip through the laptop patch path.
 *
 * The yaml is a tracked git file edited as a pending draft on the laptop; the
 * patch is authored against the git HEAD blob. The prelude in
 * settle-from-patch.ts (`git checkout HEAD -- <ws>` with generated excludes)
 * must restore a drifted on-disk copy — e.g. a legacy store hard-link left by
 * an old `ensureMasterFsOverlays` — to the HEAD pre-image first, or
 * `apply --index` rejects the pre-image mismatch.
 */
describe('settleFromPatch — tracked attachments.yaml round-trip', () => {
    let tmpRoot: string;
    let built: Awaited<ReturnType<typeof kitBuildWorkdir>>;

    beforeEach(async () => {
        built = await kitBuildWorkdir({ prefix: 'ernesto-patch-yaml-', workdirId: 'wd1' });
        tmpRoot = built.root;
    });

    afterEach(async () => {
        await built.cleanup();
    });

    /** Seed `files` in the workdir + commit; build a patch in a sibling clone
     *  seeded identically, applying `edits` on top. */
    async function seedAndBuildPatch(
        files: Record<string, string>,
        edits: Record<string, string>,
    ): Promise<{ patch: string; headSha: string }> {
        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(tmpRoot, rel);
            await mkdir(path.dirname(abs), { recursive: true });
            await writeFile(abs, content);
        }
        await runGit(tmpRoot, ['add', '-A']);
        await runGit(tmpRoot, ['commit', '-q', '-m', 'seed']);
        const headSha = (await runGit(tmpRoot, ['rev-parse', 'HEAD'])).trim();

        const stagingDir = await mkdtemp(path.join(tmpdir(), 'ernesto-patch-yaml-stage-'));
        await runGit(stagingDir, ['init', '-q', '-b', 'main']);
        await runGit(stagingDir, ['config', 'user.email', 'p@b.com']);
        await runGit(stagingDir, ['config', 'user.name', 'p']);
        await runGit(stagingDir, ['config', 'commit.gpgsign', 'false']);
        for (const [rel, content] of Object.entries(files)) {
            const abs = path.join(stagingDir, rel);
            await mkdir(path.dirname(abs), { recursive: true });
            await writeFile(abs, content);
        }
        await runGit(stagingDir, ['add', '-A']);
        await runGit(stagingDir, ['commit', '-q', '-m', 'seed']);
        for (const [rel, content] of Object.entries(edits)) {
            await writeFile(path.join(stagingDir, rel), content);
            await runGit(stagingDir, ['add', rel]);
        }
        const patch = await runGit(stagingDir, ['diff', '--cached', '--binary']);
        await rm(stagingDir, { recursive: true, force: true });
        return { patch, headSha };
    }

    it('flat workspace: a drifted on-disk yaml is restored to HEAD, the patch applies and commits', async () => {
        const yamlRel = 'workspaces/hr/attachments.yaml';
        const { patch, headSha } = await seedAndBuildPatch(
            { 'workspaces/hr/WORKSPACE.md': '---\nname: hr\n---\n', [yamlRel]: baseYaml },
            { [yamlRel]: editedYaml },
        );

        // Drift the on-disk copy away from the HEAD blob (legacy store
        // hard-link bytes). The index still points at the committed blob.
        await writeFile(path.join(tmpRoot, yamlRel), '- name: stale-store-copy.pdf\n  sha256: ff99\n');

        const r = await settleFromPatch(built.workdir, {
            workspaces: ['hr'],
            message: 'attach playbook.pdf',
            patch,
            parentSha: headSha,
            lint: allowAllLint,
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.committedPaths).toEqual([yamlRel]);
        }
        const committed = await runGit(tmpRoot, ['show', `HEAD:${yamlRel}`]);
        expect(committed).toBe(editedYaml);
    });

    it('nested workspace: the prelude resolves the boundary dir and the yaml commits', async () => {
        const yamlRel = 'workspaces/hr/recruiting/attachments.yaml';
        const { patch, headSha } = await seedAndBuildPatch(
            {
                'workspaces/hr/WORKSPACE.md': '---\nname: hr\n---\n',
                'workspaces/hr/recruiting/WORKSPACE.md': '---\nname: recruiting\n---\n',
                [yamlRel]: baseYaml,
            },
            { [yamlRel]: editedYaml },
        );

        await writeFile(path.join(tmpRoot, yamlRel), '- name: stale-store-copy.pdf\n  sha256: ff99\n');

        const r = await settleFromPatch(built.workdir, {
            workspaces: ['recruiting'],
            message: 'attach playbook.pdf (nested)',
            patch,
            parentSha: headSha,
            lint: allowAllLint,
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.committedPaths).toEqual([yamlRel]);
        }
        const committed = await runGit(tmpRoot, ['show', `HEAD:${yamlRel}`]);
        expect(committed).toBe(editedYaml);
    });
});
