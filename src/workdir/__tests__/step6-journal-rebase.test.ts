import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { rehydrateWorkdir } from '../boot';
import { settleFromWorktree, LintFn, PushToMainFn } from '../settle';
import { runGit } from '../run-git';
import { makeNodeFsAdapter } from '../node-adapters';
import { makeInMemoryWorkdirLock } from '../lock';

const enc = (s: string) => new TextEncoder().encode(s);

const allowAllLint: LintFn = async () => ({ ok: true });

/**
 * Step 6 — after a successful push, the workdir's journal branch
 * (`refs/workdirs/{wdid}`) must be reset to the new origin/main so the
 * next settle is a fast-forward.
 */
describe('settleFromWorktree — step 6 journal rebase', () => {
    let bareRoot: string;
    let workRoot: string;

    beforeEach(async () => {
        // Bare upstream repo (acts as `origin`).
        bareRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-step6-bare-'));
        await runGit(bareRoot, ['init', '-q', '--bare', '-b', 'main']);

        // Local seed clone to create the initial main commit, then push to bare.
        const seedRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-step6-seed-'));
        await runGit(seedRoot, ['init', '-q', '-b', 'main']);
        await runGit(seedRoot, ['config', 'user.email', 'poc@bitrefill.com']);
        await runGit(seedRoot, ['config', 'user.name', 'PoC']);
        await runGit(seedRoot, ['config', 'commit.gpgsign', 'false']);
        await runGit(seedRoot, ['commit', '-q', '--allow-empty', '-m', 'init']);
        await runGit(seedRoot, ['remote', 'add', 'origin', bareRoot]);
        await runGit(seedRoot, ['push', '-q', 'origin', 'main']);
        await rm(seedRoot, { recursive: true, force: true });

        // Working tree: clone bare, create journal branch from main.
        workRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-step6-work-'));
        await runGit(workRoot, ['clone', '-q', '-b', 'main', bareRoot, '.']);
        await runGit(workRoot, ['config', 'user.email', 'poc@bitrefill.com']);
        await runGit(workRoot, ['config', 'user.name', 'PoC']);
        await runGit(workRoot, ['config', 'commit.gpgsign', 'false']);
        await runGit(workRoot, ['checkout', '-q', '-b', 'refs/workdirs/wd1']);
        await mkdir(path.join(workRoot, 'workspaces', 'hr'), { recursive: true });
        await mkdir(path.join(workRoot, 'workspaces', 'cs'), { recursive: true });
    });

    afterEach(async () => {
        await rm(bareRoot, { recursive: true, force: true });
        await rm(workRoot, { recursive: true, force: true });
    });

    function buildWorkdir() {
        const fs = makeNodeFsAdapter(workRoot);
        return rehydrateWorkdir({
            workdirId: 'wd1', tier: 'managed', workingTreeRoot: workRoot,
            fs, master: { resolve: async () => ({ kind: 'not-found' }) },
            lock: makeInMemoryWorkdirLock('wd1'),
        });
    }

    /** A push that drives the bare repo's main forward to our local sha. */
    function pushSuccessFromWorktree(): PushToMainFn {
        return async ({ sha }) => {
            await runGit(workRoot, ['push', '-q', bareRoot, `${sha}:refs/heads/main`]);
            return { ok: true, sha };
        };
    }

    it('after successful push: journal branch HEAD equals origin/main', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const r = await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr',
            lint: allowAllLint,
            pushToMain: pushSuccessFromWorktree(),
        });
        expect(r.ok).toBe(true);

        // Journal branch HEAD now matches origin/main (the just-pushed sha).
        const head = (await runGit(workRoot, ['rev-parse', 'HEAD'])).trim();
        const originMain = (await runGit(workRoot, ['rev-parse', 'origin/main'])).trim();
        expect(head).toBe(originMain);

        // And the symbolic journal branch ref is what HEAD points at.
        const branch = (await runGit(workRoot, ['rev-parse', 'refs/workdirs/wd1'])).trim();
        expect(branch).toBe(originMain);
    });

    it('two consecutive settles both land on main (rebase enabled the second)', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const r1 = await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr',
            lint: allowAllLint,
            pushToMain: pushSuccessFromWorktree(),
        });
        expect(r1.ok).toBe(true);

        await workdir.fs.writeFile('workspaces/cs/WORKSPACE.md', enc('# cs\n'));

        const r2 = await settleFromWorktree(workdir, {
            workspaces: ['cs'],
            message: 'add cs',
            lint: allowAllLint,
            pushToMain: pushSuccessFromWorktree(),
        });
        expect(r2.ok).toBe(true);
        if (r2.ok) {
            expect(r2.pushed).toBe(true);
        }

        // Bare repo's main has both commits.
        const log = await runGit(bareRoot, ['log', '--format=%s', 'main']);
        expect(log).toContain('add hr');
        expect(log).toContain('add cs');
    });

    it('without pushToMain: journal branch is NOT rebased', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const beforeOriginMain = (await runGit(workRoot, ['rev-parse', 'origin/main'])).trim();

        const r = await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr',
            lint: allowAllLint,
        });
        expect(r.ok).toBe(true);

        // No push happened, so origin/main hasn't moved AND HEAD is past it.
        const afterOriginMain = (await runGit(workRoot, ['rev-parse', 'origin/main'])).trim();
        expect(afterOriginMain).toBe(beforeOriginMain);

        const head = (await runGit(workRoot, ['rev-parse', 'HEAD'])).trim();
        expect(head).not.toBe(afterOriginMain);

        // HEAD is a child of origin/main (the local commit on the journal branch).
        const parent = (await runGit(workRoot, ['rev-parse', 'HEAD^'])).trim();
        expect(parent).toBe(afterOriginMain);
    });

    it('pushToMain returns fast_forward_required: journal branch is NOT rebased', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const beforeOriginMain = (await runGit(workRoot, ['rev-parse', 'origin/main'])).trim();

        const pushToMain: PushToMainFn = async () => ({
            ok: false, error: 'fast_forward_required', currentSha: 'upstream-xyz',
        });

        const r = await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr',
            lint: allowAllLint,
            pushToMain,
        });
        expect(r).toEqual({ ok: false, error: 'fast_forward_required', currentSha: 'upstream-xyz' });

        // Push didn't land → no rebase. Local commit is still on the journal branch
        // ahead of origin/main (which hasn't moved).
        const afterOriginMain = (await runGit(workRoot, ['rev-parse', 'origin/main'])).trim();
        expect(afterOriginMain).toBe(beforeOriginMain);

        const head = (await runGit(workRoot, ['rev-parse', 'HEAD'])).trim();
        expect(head).not.toBe(afterOriginMain);

        const parent = (await runGit(workRoot, ['rev-parse', 'HEAD^'])).trim();
        expect(parent).toBe(afterOriginMain);
    });
});
