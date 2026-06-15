import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { LintFn, LintError, PushToMainFn } from '../settle';
import { settleFromOverlay } from '../settle-from-overlay';
import { runGit } from '../run-git';
import type { Workdir } from '../types';
import type { WorkspacePatch } from '../../workspaces/overlay';
import { buildWorkdir as kitBuildWorkdir } from '../../__tests__/kit';

const allowAllLint: LintFn = async () => ({ ok: true });
const denyLint: (errors: ReadonlyArray<LintError>) => LintFn = (errors) => async () => ({ ok: false, errors });

describe('settleFromOverlay — server-side 3-way reconcile', () => {
    let root: string;
    let baseSha: string;
    let built: Awaited<ReturnType<typeof kitBuildWorkdir>>;

    beforeEach(async () => {
        built = await kitBuildWorkdir({ prefix: 'ernesto-overlay-settle-', workdirId: 'wd1' });
        root = built.root;
        await mkdir(path.join(root, 'workspaces', 'hr'), { recursive: true });
        await writeFile(path.join(root, 'workspaces', 'hr', 'WORKSPACE.md'), '---\nname: hr\n---\n');
        await writeFile(path.join(root, 'workspaces', 'hr', 'handbook.md'), 'base line\n');
        await runGit(root, ['add', '-A']);
        await runGit(root, ['commit', '-q', '-m', 'base']);
        baseSha = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
    });

    afterEach(async () => {
        await built.cleanup();
    });

    function buildWorkdir(): Workdir {
        return built.workdir;
    }

    it('clean apply: overlay reconciles against current main, lints, commits', async () => {
        const workdir = buildWorkdir();
        const patch: WorkspacePatch = {
            baseSha,
            files: { 'workspaces/hr/notes.md': { content: 'overlay notes\n' } },
        };

        let seenDiff = '';
        const captureLint: LintFn = async (input) => {
            seenDiff = input.diff;
            return { ok: true };
        };

        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'add hr notes via overlay',
            patch,
            lint: captureLint,
        });

        expect(r.ok).toBe(true);
        expect(seenDiff).toContain('workspaces/hr/notes.md');

        const tree = await runGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(tree).toContain('workspaces/hr/notes.md');
        const log = await runGit(root, ['log', '-1', '--format=%s']);
        expect(log).toContain('add hr notes via overlay');
    });

    it('clean apply over a MOVED main: a non-overlapping main change is preserved', async () => {
        // main moves past baseSha: a new file the overlay never saw.
        await writeFile(path.join(root, 'workspaces', 'hr', 'policy.md'), 'main added policy\n');
        await runGit(root, ['add', '-A']);
        await runGit(root, ['commit', '-q', '-m', 'main adds policy']);

        const workdir = buildWorkdir();
        const patch: WorkspacePatch = {
            baseSha, // authored against the OLD base
            files: { 'workspaces/hr/notes.md': { content: 'overlay notes\n' } },
        };

        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'overlay over moved main',
            patch,
            lint: allowAllLint,
        });

        expect(r.ok).toBe(true);
        const tree = await runGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(tree).toContain('workspaces/hr/notes.md'); // overlay's add
        expect(tree).toContain('workspaces/hr/policy.md'); // main's add — not clobbered
    });

    it('CONFLICT: a file the overlay edits also changed on main → overlay_conflict, no commit', async () => {
        // main diverges on handbook.md after baseSha.
        await writeFile(path.join(root, 'workspaces', 'hr', 'handbook.md'), 'MAIN rewrote this\n');
        await runGit(root, ['add', '-A']);
        await runGit(root, ['commit', '-q', '-m', 'main rewrites handbook']);
        const headBefore = (await runGit(root, ['rev-parse', 'HEAD'])).trim();

        const workdir = buildWorkdir();
        // The overlay (authored against baseSha) rewrites the SAME file differently.
        const patch: WorkspacePatch = {
            baseSha,
            files: { 'workspaces/hr/handbook.md': { content: 'OVERLAY rewrote this\n' } },
        };

        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'conflicting overlay',
            patch,
            lint: allowAllLint,
        });

        expect(r.ok).toBe(false);
        if (!r.ok && r.error === 'overlay_conflict') {
            expect(r.paths).toContain('workspaces/hr/handbook.md');
            // A3: the conflict result is diagnosable — it carries the seeded
            // merge base and the HEAD the 3-way ran against.
            expect(r.baseSha).toBe(baseSha);
            expect(r.headSha).toBe(headBefore);
        } else {
            throw new Error(`expected overlay_conflict, got ${JSON.stringify(r)}`);
        }

        // No commit landed.
        expect((await runGit(root, ['rev-parse', 'HEAD'])).trim()).toBe(headBefore);
    });

    it('by-reference selection: a 1-path selection of a 2-file patch commits ONLY that path', async () => {
        const workdir = buildWorkdir();
        const patch: WorkspacePatch = {
            baseSha,
            files: {
                'workspaces/hr/keep.md': { content: 'commit me\n' },
                'workspaces/hr/scratch.md': { content: 'leave me\n' },
            },
        };

        let seenDiff = '';
        const captureLint: LintFn = async (input) => {
            seenDiff = input.diff;
            return { ok: true };
        };

        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'settle only keep.md',
            patch,
            lint: captureLint,
            files: ['workspaces/hr/keep.md'],
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            // committedPaths is ground truth: only the selected path.
            expect(r.committedPaths).toEqual(['workspaces/hr/keep.md']);
        }

        // Lint gated on the selected subset only.
        expect(seenDiff).toContain('workspaces/hr/keep.md');
        expect(seenDiff).not.toContain('workspaces/hr/scratch.md');

        // The committed tree has the selected file; the unselected one never landed.
        const tree = await runGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(tree).toContain('workspaces/hr/keep.md');
        expect(tree).not.toContain('workspaces/hr/scratch.md');
    });

    it('omitted selection preserves whole-workspace publish (both files land)', async () => {
        const workdir = buildWorkdir();
        const patch: WorkspacePatch = {
            baseSha,
            files: {
                'workspaces/hr/a.md': { content: 'a\n' },
                'workspaces/hr/b.md': { content: 'b\n' },
            },
        };

        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'publish all',
            patch,
            lint: allowAllLint,
            // files omitted ⇒ today's behavior
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect([...r.committedPaths].sort()).toEqual(['workspaces/hr/a.md', 'workspaces/hr/b.md']);
        }
        const tree = await runGit(root, ['ls-tree', '-r', '--name-only', 'HEAD']);
        expect(tree).toContain('workspaces/hr/a.md');
        expect(tree).toContain('workspaces/hr/b.md');
    });

    it('selecting a path ABSENT from the patch matches nothing → empty_selection, no commit', async () => {
        const workdir = buildWorkdir();
        const headBefore = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
        const patch: WorkspacePatch = {
            baseSha,
            files: { 'workspaces/hr/present.md': { content: 'here\n' } },
        };

        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'select a ghost',
            patch,
            lint: allowAllLint,
            files: ['workspaces/hr/not-in-draft.md'],
        });

        expect(r).toEqual({ ok: false, error: 'patch_rejected', reason: 'empty_selection' });
        // Nothing landed; the present draft entry is untouched.
        expect((await runGit(root, ['rev-parse', 'HEAD'])).trim()).toBe(headBefore);
    });

    it('a selection partly out of scope still commits ONLY the in-scope+selected subset', async () => {
        // Selection can never WIDEN: an out-of-scope element is simply not in the
        // in-scope draft, so it falls away and only the in-scope selected path lands.
        const workdir = buildWorkdir();
        const patch: WorkspacePatch = {
            baseSha,
            files: { 'workspaces/hr/keep.md': { content: 'k\n' } },
        };

        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'mixed selection',
            patch,
            lint: allowAllLint,
            files: ['workspaces/hr/keep.md', 'workspaces/other/x.md'],
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.committedPaths).toEqual(['workspaces/hr/keep.md']);
        }
    });

    it('rejects an empty patch', async () => {
        const workdir = buildWorkdir();
        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'empty',
            patch: { baseSha, files: {} },
            lint: allowAllLint,
        });
        expect(r).toEqual({ ok: false, error: 'patch_rejected', reason: 'empty_patch' });
    });

    it('rejects an unknown base sha', async () => {
        const workdir = buildWorkdir();
        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'bad base',
            patch: { baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', files: { 'workspaces/hr/x.md': { content: 'x\n' } } },
            lint: allowAllLint,
        });
        expect(r.ok).toBe(false);
        if (!r.ok && r.error === 'patch_rejected') {
            expect(r.reason).toContain('unknown_base_sha');
        } else {
            throw new Error(`expected patch_rejected, got ${JSON.stringify(r)}`);
        }
    });

    it('lint failure hard-resets the ephemeral tree, surfaces errors, no commit', async () => {
        const workdir = buildWorkdir();
        const headBefore = (await runGit(root, ['rev-parse', 'HEAD'])).trim();
        const errors: ReadonlyArray<LintError> = [{ code: 'bad', message: 'nope' }];
        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'will be rejected',
            patch: { baseSha, files: { 'workspaces/hr/notes.md': { content: 'n\n' } } },
            lint: denyLint(errors),
        });
        expect(r).toEqual({ ok: false, error: 'lint_failed', errors });
        expect((await runGit(root, ['rev-parse', 'HEAD'])).trim()).toBe(headBefore);
        const status = await runGit(root, ['status', '--porcelain', '-uall']);
        expect(status.trim()).toBe(''); // hard reset cleaned the tree
    });

    it('pushToMain is invoked on a clean settle', async () => {
        const workdir = buildWorkdir();
        let seenBranchRef: string | null = null;
        const pushToMain: PushToMainFn = async (input) => {
            seenBranchRef = input.branchRef;
            return { ok: true, sha: 'bot-sha-xyz' };
        };
        const r = await settleFromOverlay(workdir, {
            workspaces: ['hr'],
            message: 'pushed overlay',
            patch: { baseSha, files: { 'workspaces/hr/notes.md': { content: 'n\n' } } },
            lint: allowAllLint,
            pushToMain,
        });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.pushed).toBe(true);
            expect(r.sha).toBe('bot-sha-xyz');
        }
        expect(seenBranchRef).toBe('refs/workdirs/wd1');
    });
});
