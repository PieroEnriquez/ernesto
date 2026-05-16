import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { rehydrateWorkdir } from '../boot';
import { runGit } from '../run-git';
import { makeNodeFsAdapter } from '../node-adapters';
import { makeInMemoryWorkdirLock } from '../lock';
import { settleFromPatch } from '../settle-from-patch';
import type { LintFn, PushToMainFn } from '../settle';

const allowAllLint: LintFn = async () => ({ ok: true });

const denyLint: LintFn = async () => ({
    ok: false,
    errors: [{ code: 'denied', message: 'no' }],
});

describe('settleFromPatch', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-patch-'));
        await runGit(tmpRoot, ['init', '-q', '-b', 'main']);
        await runGit(tmpRoot, ['config', 'user.email', 'poc@bitrefill.com']);
        await runGit(tmpRoot, ['config', 'user.name', 'PoC']);
        await runGit(tmpRoot, ['config', 'commit.gpgsign', 'false']);
        await mkdir(path.join(tmpRoot, 'workspaces'), { recursive: true });
        await runGit(tmpRoot, ['commit', '-q', '--allow-empty', '-m', 'init']);
    });

    afterEach(async () => {
        await rm(tmpRoot, { recursive: true, force: true });
    });

    function buildWorkdir() {
        const fs = makeNodeFsAdapter(tmpRoot);
        return rehydrateWorkdir({
            workdirId: 'wd1', tier: 'local-fs', workingTreeRoot: tmpRoot,
            fs, master: { resolve: async () => ({ kind: 'not-found' }) },
            lock: makeInMemoryWorkdirLock('wd1'),
        });
    }

    async function makePatch(): Promise<{ patch: string; parentSha: string }> {
        // Build a patch by staging a change in a sibling clone, then resetting.
        const stagingDir = await mkdtemp(path.join(tmpdir(), 'ernesto-stage-'));
        await runGit(stagingDir, ['init', '-q', '-b', 'main']);
        await runGit(stagingDir, ['config', 'user.email', 'p@b.com']);
        await runGit(stagingDir, ['config', 'user.name', 'p']);
        await runGit(stagingDir, ['config', 'commit.gpgsign', 'false']);
        await runGit(stagingDir, ['commit', '-q', '--allow-empty', '-m', 'init']);
        const parentSha = (await runGit(stagingDir, ['rev-parse', 'HEAD'])).trim();

        await mkdir(path.join(stagingDir, 'workspaces', 'tier-c'), { recursive: true });
        await writeFile(
            path.join(stagingDir, 'workspaces', 'tier-c', 'WORKSPACE.md'),
            '---\nname: tier-c\n---\n# tier-c\n',
        );
        await runGit(stagingDir, ['add', 'workspaces/tier-c/WORKSPACE.md']);
        const patch = await runGit(stagingDir, ['diff', '--cached', '--binary']);
        await rm(stagingDir, { recursive: true, force: true });

        // The new workdir's HEAD will be a different sha (different repo).
        // For the parentSha equality test below, we need to align them — so
        // the caller uses the workdir's actual HEAD as parentSha. We return
        // a marker meaning "use workdir HEAD"; in the real flow the CLI
        // captures parentSha from its own clone of the same origin.
        void parentSha;
        return { patch, parentSha: '' };
    }

    it('clean patch + lint pass → commits and returns sha', async () => {
        const workdir = buildWorkdir();
        const headSha = (await runGit(tmpRoot, ['rev-parse', 'HEAD'])).trim();
        const { patch } = await makePatch();

        const r = await settleFromPatch(workdir, {
            workspaces: ['tier-c'],
            message: 'add tier-c workspace',
            patch,
            parentSha: headSha,
            lint: allowAllLint,
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.pushed).toBe(false);
            expect(r.sha).toBeTruthy();
        }
        const log = await runGit(tmpRoot, ['log', '--format=%s']);
        expect(log).toContain('add tier-c workspace');
    });

    it('parentSha mismatch → fast_forward_required, no commit', async () => {
        const workdir = buildWorkdir();
        const { patch } = await makePatch();

        const r = await settleFromPatch(workdir, {
            workspaces: ['tier-c'],
            message: 'should fail',
            patch,
            parentSha: '0000000000000000000000000000000000000000',
            lint: allowAllLint,
        });

        expect(r.ok).toBe(false);
        if (!r.ok && r.error === 'fast_forward_required') {
            expect(r.currentSha).toBeTruthy();
        } else {
            throw new Error(`expected fast_forward_required, got ${JSON.stringify(r)}`);
        }
    });

    it('lint failure → patch reverted, no commit', async () => {
        const workdir = buildWorkdir();
        const headSha = (await runGit(tmpRoot, ['rev-parse', 'HEAD'])).trim();
        const { patch } = await makePatch();

        const r = await settleFromPatch(workdir, {
            workspaces: ['tier-c'],
            message: 'should lint-fail',
            patch,
            parentSha: headSha,
            lint: denyLint,
        });

        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error).toBe('lint_failed');

        const log = await runGit(tmpRoot, ['log', '--format=%s']);
        expect(log).not.toContain('should lint-fail');
    });

    it('empty patch → patch_rejected', async () => {
        const workdir = buildWorkdir();
        const headSha = (await runGit(tmpRoot, ['rev-parse', 'HEAD'])).trim();
        const r = await settleFromPatch(workdir, {
            workspaces: ['tier-c'],
            message: 'x',
            patch: '',
            parentSha: headSha,
            lint: allowAllLint,
        });
        expect(r.ok).toBe(false);
        if (!r.ok && r.error === 'patch_rejected') {
            expect(r.reason).toContain('empty');
        } else {
            throw new Error('expected patch_rejected');
        }
    });

    /**
     * Reproduces the live-mirror overlay race that almost shipped:
     *   - The workdir has WORKSPACE.md committed at git blob version B0.
     *   - At boot, `ensureMasterFsOverlays` hard-links master-fs's version
     *     (B0 + derive-injected auto-blocks ≈ B0') over the checked-out file.
     *     The on-disk content is now B0'; the git index/HEAD still points to B0.
     *   - The laptop authored its patch against B0 (it has no overlay).
     *   - `git apply --check --index` reads the on-disk pre-image B0' and
     *     compares it to the patch's pre-image B0 — mismatch → reject.
     *
     * Fix in settle-from-patch.ts: `git checkout HEAD -- workspaces/<ws>`
     * (with `:(exclude)extracted` and `:(exclude)attached`) restores the
     * workspace's tracked files to the committed blob and breaks the hard
     * link, giving us the exact bytes the patch was authored against.
     */
    it('overlay race: on-disk WORKSPACE.md differs from HEAD blob → apply still succeeds', async () => {
        const workdir = buildWorkdir();

        // Seed a real committed WORKSPACE.md (blob = B0). Use a multi-line file
        // so the diff hunk context lines pin a specific pre-image.
        const wsDir = path.join(tmpRoot, 'workspaces', 'tier-c');
        await mkdir(wsDir, { recursive: true });
        const baseContent = '---\nname: tier-c\n---\n# tier-c\n\nbody\n';
        await writeFile(path.join(wsDir, 'WORKSPACE.md'), baseContent);
        await runGit(tmpRoot, ['add', 'workspaces/tier-c/WORKSPACE.md']);
        await runGit(tmpRoot, ['commit', '-q', '-m', 'seed tier-c']);
        const headSha = (await runGit(tmpRoot, ['rev-parse', 'HEAD'])).trim();

        // Build the laptop's patch in a staging clone whose HEAD matches B0.
        // It edits B0 → B1 (appends a line).
        const stagingDir = await mkdtemp(path.join(tmpdir(), 'ernesto-overlay-stage-'));
        await runGit(stagingDir, ['init', '-q', '-b', 'main']);
        await runGit(stagingDir, ['config', 'user.email', 'p@b.com']);
        await runGit(stagingDir, ['config', 'user.name', 'p']);
        await runGit(stagingDir, ['config', 'commit.gpgsign', 'false']);
        await mkdir(path.join(stagingDir, 'workspaces', 'tier-c'), { recursive: true });
        await writeFile(path.join(stagingDir, 'workspaces', 'tier-c', 'WORKSPACE.md'), baseContent);
        await runGit(stagingDir, ['add', '-A']);
        await runGit(stagingDir, ['commit', '-q', '-m', 'seed']);
        // Now author the change against B0:
        await writeFile(
            path.join(stagingDir, 'workspaces', 'tier-c', 'WORKSPACE.md'),
            baseContent + '\nappended by laptop\n',
        );
        await runGit(stagingDir, ['add', 'workspaces/tier-c/WORKSPACE.md']);
        const patch = await runGit(stagingDir, ['diff', '--cached', '--binary']);
        await rm(stagingDir, { recursive: true, force: true });

        // Simulate the overlay: rewrite the on-disk file to B0' (different
        // bytes than the committed blob). Index still references B0.
        const overlayed = baseContent + '<!-- @routes-owned start -->\n@stub\n<!-- @routes-owned end -->\n';
        await writeFile(path.join(wsDir, 'WORKSPACE.md'), overlayed);

        // Sanity check: a naive `git apply --check --index` rejects this.
        // (Optional — kept as a regression marker, not asserted.)

        // Drop in an unrelated extracted/ overlay too; the restore step must
        // NOT touch it (path-spec excluded). We assert it survives untouched.
        const extractedPath = path.join(wsDir, 'extracted', 'note.md');
        await mkdir(path.dirname(extractedPath), { recursive: true });
        const extractedBytes = '# transient overlay — must survive checkout\n';
        await writeFile(extractedPath, extractedBytes);

        const r = await settleFromPatch(workdir, {
            workspaces: ['tier-c'],
            message: 'patch against blob with overlay on disk',
            patch,
            parentSha: headSha,
            lint: allowAllLint,
        });

        expect(r.ok).toBe(true);
        // Post-condition: the commit landed and contains the appended line.
        const { readFile } = await import('fs/promises');
        const after = await readFile(path.join(wsDir, 'WORKSPACE.md'), 'utf8');
        expect(after).toContain('appended by laptop');

        // Extracted overlay file must still exist and be untouched — the
        // checkout was pathspec-excluded.
        const extractedAfter = await readFile(extractedPath, 'utf8');
        expect(extractedAfter).toBe(extractedBytes);
    });

    it('bot pushToMain wired → returns sha and pushed=true', async () => {
        const workdir = buildWorkdir();
        const headSha = (await runGit(tmpRoot, ['rev-parse', 'HEAD'])).trim();
        const { patch } = await makePatch();

        let pushedSha = '';
        const fakePush: PushToMainFn = async ({ sha }) => {
            pushedSha = sha;
            return { ok: true, sha };
        };

        const r = await settleFromPatch(workdir, {
            workspaces: ['tier-c'],
            message: 'pushed-tier-c',
            patch,
            parentSha: headSha,
            lint: allowAllLint,
            pushToMain: fakePush,
            trailers: { Tier: 'C', User: 'trb' },
        });

        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.pushed).toBe(true);
            expect(pushedSha).toBe(r.sha);
        }
        const commitMsg = await runGit(tmpRoot, ['log', '-1', '--format=%B']);
        expect(commitMsg).toContain('Tier: C');
        expect(commitMsg).toContain('User: trb');
    });
});
