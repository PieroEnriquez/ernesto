import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir } from 'fs/promises';
import * as path from 'path';
import { settleFromWorktree, LintFn, LintError, PushToMainFn } from '../settle';
import { runGit } from '../run-git';
import type { Workdir } from '../types';
import { buildWorkdir as kitBuildWorkdir } from '../../__tests__/kit';

const enc = (s: string) => new TextEncoder().encode(s);

const allowAllLint: LintFn = async () => ({ ok: true });

const denyLint: (errors: ReadonlyArray<LintError>) => LintFn =
    (errors) => async () => ({ ok: false, errors });

describe('settleFromWorktree', () => {
    let tmpRoot: string;
    let built: Awaited<ReturnType<typeof kitBuildWorkdir>>;

    beforeEach(async () => {
        built = await kitBuildWorkdir({ prefix: 'ernesto-settle-', workdirId: 'wd1' });
        tmpRoot = built.root;
        await mkdir(path.join(tmpRoot, 'workspaces', 'hr'), { recursive: true });
        await mkdir(path.join(tmpRoot, 'workspaces', 'cs'), { recursive: true });
    });

    afterEach(async () => {
        await built.cleanup();
    });

    function buildWorkdir(): Workdir {
        return built.workdir;
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
            trailers: { 'Workdir-Id': 'wd1', 'User': 'poc@example.com', 'Transport': 'in-process' },
        });

        const body = await runGit(tmpRoot, ['log', '-1', '--format=%B']);
        expect(body).toContain('add hr');
        expect(body).toContain('Workdir-Id: wd1');
        expect(body).toContain('User: poc@example.com');
        expect(body).toContain('Transport: in-process');
    });

    it('relocates a workspace under a parent: stages the move, lints both rename endpoints', async () => {
        const workdir = buildWorkdir();
        // Seed pricing (top-level) + product (parent), commit.
        await workdir.fs.writeFile('workspaces/pricing/WORKSPACE.md', enc('---\nname: pricing\n---\n'));
        await workdir.fs.writeFile('workspaces/product/WORKSPACE.md', enc('---\nname: product\n---\n'));
        await runGit(tmpRoot, ['add', '-A']);
        await runGit(tmpRoot, ['commit', '-q', '-m', 'seed pricing+product']);

        // Relocate pricing under product (the move that used to fatal at staging).
        await runGit(tmpRoot, ['mv', 'workspaces/pricing', 'workspaces/product/pricing']);

        let captured = '';
        const capturingLint: LintFn = async ({ diff }) => { captured = diff; return { ok: true }; };

        const r = await settleFromWorktree(workdir, {
            workspaces: ['pricing', 'product'], // declare by leaf identity
            message: 'group pricing under product',
            lint: capturingLint,
        });

        expect(r.ok).toBe(true);
        // The diff pairs the rename: BOTH endpoints present (old + new), so the
        // relocation's deletion side is linted, not silently dropped.
        expect(captured).toContain('workspaces/pricing/WORKSPACE.md');
        expect(captured).toContain('workspaces/product/pricing/WORKSPACE.md');
        // The commit tree has the new location and not the old.
        const tree = await runGit(tmpRoot, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(tree).toContain('workspaces/product/pricing/WORKSPACE.md');
        expect(tree).not.toContain('workspaces/pricing/WORKSPACE.md');
    });
});
