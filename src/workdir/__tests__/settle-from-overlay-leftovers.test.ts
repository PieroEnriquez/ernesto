import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, stat } from 'fs/promises';
import * as path from 'path';
import { LintFn } from '../settle';
import { settleFromOverlay } from '../settle-from-overlay';
import { runGit } from '../run-git';
import type { WorkspacePatch } from '../../workspaces/overlay';
import { buildWorkdir as kitBuildWorkdir } from '../../__tests__/kit';

const allowAllLint: LintFn = async () => ({ ok: true });

describe('settleFromOverlay — untracked worktree leftovers stay out of the commit', () => {
    let root: string;
    let baseSha: string;
    let built: Awaited<ReturnType<typeof kitBuildWorkdir>>;

    beforeEach(async () => {
        built = await kitBuildWorkdir({ prefix: 'ernesto-overlay-leftover-', workdirId: 'wd1' });
        root = built.root;
        await mkdir(path.join(root, 'workspaces', 'hr'), { recursive: true });
        await writeFile(path.join(root, 'workspaces', 'hr', 'WORKSPACE.md'), '---\nname: hr\n---\n');
        await runGit(root, ['add', '-A']);
        await runGit(root, ['commit', '-q', '-m', 'base']);
        baseSha = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
    });

    afterEach(async () => {
        await built.cleanup();
    });

    it('an untracked attached/ leftover in the staging tree is NOT committed', async () => {
        // Regression pin for the `git add -A` deletion: persistent workdirs
        // carry untracked `attached/` hard-link leftovers (GeneratedStore byte
        // mirrors) that `prepareSettleStagingWorktree` normally clears — but
        // the lib must be safe without that courtesy. The old `add -A` after
        // the read-tree re-staged exactly these into the commit.
        const leftover = path.join(root, 'workspaces', 'hr', 'attached', 'playbook_5a8c0102.pdf');
        await mkdir(path.dirname(leftover), { recursive: true });
        await writeFile(leftover, 'fake pdf bytes\n');

        const patch: WorkspacePatch = {
            baseSha,
            files: { 'workspaces/hr/notes.md': { content: 'overlay notes\n' } },
        };

        const r = await settleFromOverlay(built.workdir, {
            workspaces: ['hr'],
            message: 'overlay settle with a leftover in the tree',
            patch,
            lint: allowAllLint,
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.committedPaths).toEqual(['workspaces/hr/notes.md']);
        }

        const tree = await runGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(tree).toContain('workspaces/hr/notes.md');
        expect(tree).not.toContain('attached');

        // The leftover survives on disk, still untracked — never deleted,
        // never staged.
        await expect(stat(leftover)).resolves.toBeTruthy();
        const status = await runGit(root, ['status', '--porcelain', '-uall']);
        expect(status).toContain('?? workspaces/hr/attached/playbook_5a8c0102.pdf');
    });
});
