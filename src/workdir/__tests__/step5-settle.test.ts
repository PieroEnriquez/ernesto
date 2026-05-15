import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { rehydrateWorkdir } from '../boot';
import { settleFromWorktree, LintFn, LintError, PushToMainFn } from '../settle';
import { runGit } from '../run-git';
import { makeNodeFsAdapter } from '../node-adapters';
import { makeInMemoryWorkdirLock } from '../lock';

const enc = (s: string) => new TextEncoder().encode(s);

const allowAllLint: LintFn = async () => ({ ok: true });

const denyLint: (errors: ReadonlyArray<LintError>) => LintFn =
    (errors) => async () => ({ ok: false, errors });

describe('settleFromWorktree', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-settle-'));
        await runGit(tmpRoot, ['init', '-q', '-b', 'main']);
        await runGit(tmpRoot, ['config', 'user.email', 'poc@bitrefill.com']);
        await runGit(tmpRoot, ['config', 'user.name', 'PoC']);
        await runGit(tmpRoot, ['config', 'commit.gpgsign', 'false']);
        await mkdir(path.join(tmpRoot, 'workspaces', 'hr'), { recursive: true });
        await mkdir(path.join(tmpRoot, 'workspaces', 'cs'), { recursive: true });
        await runGit(tmpRoot, ['commit', '-q', '--allow-empty', '-m', 'init']);
    });

    afterEach(async () => {
        await rm(tmpRoot, { recursive: true, force: true });
    });

    function buildWorkdir() {
        const fs = makeNodeFsAdapter(tmpRoot);
        return rehydrateWorkdir({
            workdirId: 'wd1', tier: 'managed', workingTreeRoot: tmpRoot,
            fs, master: { resolve: async () => ({ kind: 'not-found' }) },
            lock: makeInMemoryWorkdirLock('wd1'),
        });
    }

    it('lint-pass + no pushToMain → returns commit sha, pushed=false', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const r = await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr workspace',
            lint: allowAllLint,
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.pushed).toBe(false);
            expect(r.sha).toBeTruthy();
        }

        const log = await runGit(tmpRoot, ['log', '--format=%s']);
        expect(log).toContain('add hr workspace');
    });

    it('lint-fail → no commit, returns lint errors', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# bad\n'));

        const errors: ReadonlyArray<LintError> = [
            { code: 'missing_frontmatter', workspace: 'hr', path: 'workspaces/hr/WORKSPACE.md', message: 'WORKSPACE.md must have frontmatter' },
        ];
        const r = await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr',
            lint: denyLint(errors),
        });

        expect(r).toEqual({ ok: false, error: 'lint_failed', errors });

        const log = await runGit(tmpRoot, ['log', '--format=%s']);
        expect(log).not.toContain('add hr');

        const status = await runGit(tmpRoot, ['status', '--porcelain', '-uall']);
        expect(status).toContain('?? workspaces/hr/WORKSPACE.md');
    });

    it('excludes attachments.yaml from staging — master-fs overlay, not author intent', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));
        // Simulate an attach-time hardlink: a yaml file in the workdir that
        // mirrors master-fs. Settle must treat it the same way it treats
        // extracted/ and attached/ — invisible to staging.
        await workdir.fs.writeFile('workspaces/hr/attachments.yaml', enc('- name: x\n'));

        let seen: { diff: string } | null = null;
        const captureLint: LintFn = async (input) => { seen = input; return { ok: true }; };

        await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr',
            lint: captureLint,
        });

        expect(seen).not.toBeNull();
        expect(seen!.diff).toContain('workspaces/hr/WORKSPACE.md');
        expect(seen!.diff).not.toContain('attachments.yaml');
    });

    it('lint receives the staged diff scoped to workspaces[]', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));
        await workdir.fs.writeFile('workspaces/cs/WORKSPACE.md', enc('# cs\n'));

        let seen: { diff: string; workspaces: ReadonlyArray<string> } | null = null;
        const captureLint: LintFn = async (input) => { seen = input; return { ok: true }; };

        await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr only',
            lint: captureLint,
        });

        expect(seen).not.toBeNull();
        expect(seen!.workspaces).toEqual(['hr']);
        expect(seen!.diff).toContain('workspaces/hr/WORKSPACE.md');
        expect(seen!.diff).not.toContain('workspaces/cs/WORKSPACE.md');
    });

    it('pushToMain success → returns pushed=true with the bot sha', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        let seenBranchRef: string | null = null;
        const pushToMain: PushToMainFn = async (input) => {
            seenBranchRef = input.branchRef;
            return { ok: true, sha: 'bot-sha-abc' };
        };

        const r = await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr',
            lint: allowAllLint,
            pushToMain,
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.pushed).toBe(true);
            expect(r.sha).toBe('bot-sha-abc');
        }
        expect(seenBranchRef).toBe('refs/workdirs/wd1');
    });

    it('pushToMain fast_forward_required is propagated', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

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
    });

    it('trailers are appended to the commit message', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        await settleFromWorktree(workdir, {
            workspaces: ['hr'],
            message: 'add hr',
            lint: allowAllLint,
            trailers: { 'Workdir-Id': 'wd1', 'User': 'poc@bitrefill.com', 'Tier': 'A' },
        });

        const body = await runGit(tmpRoot, ['log', '-1', '--format=%B']);
        expect(body).toContain('add hr');
        expect(body).toContain('Workdir-Id: wd1');
        expect(body).toContain('User: poc@bitrefill.com');
        expect(body).toContain('Tier: A');
    });
});
