import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { runGit } from '../../workdir/run-git';
import type { LintFn, LintError, PushToMainFn, Workdir } from '../../workdir';
import { handleSettle } from '../settle';
import type { SettleVerbContext } from '../settle';
import { buildWorkdir as kitBuildWorkdir } from '../../__tests__/kit';

const enc = (s: string) => new TextEncoder().encode(s);

const allowAllLint: LintFn = async () => ({ ok: true });
const denyLint =
    (errors: ReadonlyArray<LintError>): LintFn =>
    async () => ({ ok: false, errors });
const okPush: PushToMainFn = async ({ sha }) => ({ ok: true, sha });

function makeLog() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('handleSettle', () => {
    let tmpRoot: string;
    let built: Awaited<ReturnType<typeof kitBuildWorkdir>>;

    beforeEach(async () => {
        built = await kitBuildWorkdir({ prefix: 'ernesto-verbs-settle-', workdirId: 'wd1' });
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

    function makeCtx(overrides: Partial<SettleVerbContext> = {}): SettleVerbContext {
        return {
            user: { id: 'u1' },
            scopes: new Set(['test:write']),
            lint: allowAllLint,
            pushToMain: okPush,
            log: makeLog(),
            ...overrides,
        };
    }

    it('happy path: derives workspaces, pushes, fires onSettleSuccess', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const onSuccess = vi.fn(async () => {});
        const onFailure = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleSuccess: onSuccess, onSettleFailure: onFailure } });

        const r = await handleSettle(workdir, { message: 'add hr' }, ctx);

        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.pushed).toBe(true);
        expect(r.sha).toBeTruthy();
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onSuccess.mock.calls[0][0]).toEqual(['hr']);
        expect(onSuccess.mock.calls[0][1]).toBe(r.sha);
        expect(onSuccess.mock.calls[0][2]).toBe(true);
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('derives multiple workspaces from a multi-workspace diff', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));
        await workdir.fs.writeFile('workspaces/cs/WORKSPACE.md', enc('# cs\n'));

        const onSuccess = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleSuccess: onSuccess } });

        const r = await handleSettle(workdir, { message: 'add hr + cs' }, ctx);
        expect(r.ok).toBe(true);
        expect(onSuccess.mock.calls[0][0]).toEqual(['cs', 'hr']); // sorted
    });

    it('ignores attachments.yaml + extracted/ + attached/ when deriving workspaces', async () => {
        const workdir = buildWorkdir();
        // The agent only edited hr. _tmp has a master-fs overlay
        // (attachments.yaml from _ernesto://attach) and _ernesto has
        // an empty `attached/` dir from the mirror — neither is author
        // intent and neither should pull those workspaces into the
        // settle set.
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));
        await workdir.fs.writeFile('workspaces/_tmp/attachments.yaml', enc('- name: x\n'));
        await workdir.fs.writeFile('workspaces/_ernesto/attached/note.txt', enc('y\n'));

        const onSuccess = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleSuccess: onSuccess } });

        const r = await handleSettle(workdir, { message: 'edit hr' }, ctx);
        expect(r.ok).toBe(true);
        expect(onSuccess.mock.calls[0][0]).toEqual(['hr']);
    });

    it('ignores out-of-workspace changes when deriving workspaces', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));
        // A non-workspace file change is invisible to settle's workspace
        // derivation. Settle only touches `workspaces/<name>/...`.
        await workdir.fs.writeFile('README.md', enc('readme\n'));

        const onSuccess = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleSuccess: onSuccess } });

        const r = await handleSettle(workdir, { message: 'add hr' }, ctx);
        expect(r.ok).toBe(true);
        expect(onSuccess.mock.calls[0][0]).toEqual(['hr']);
    });

    it('lint failure → returns lint_failed, fires onSettleFailure with workspaces + errors', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# bad\n'));

        const errors: ReadonlyArray<LintError> = [{ code: 'bad', workspace: 'hr', message: 'nope' }];
        const onSuccess = vi.fn(async () => {});
        const onFailure = vi.fn(async () => {});
        const ctx = makeCtx({
            lint: denyLint(errors),
            hooks: { onSettleSuccess: onSuccess, onSettleFailure: onFailure },
        });

        const r = await handleSettle(workdir, { message: 'add hr' }, ctx);

        expect(r).toEqual({ ok: false, error: 'lint_failed', errors });
        expect(onSuccess).not.toHaveBeenCalled();
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onFailure.mock.calls[0][0]).toEqual(['hr']);
        expect(onFailure.mock.calls[0][1]).toBe('lint_failed');
        expect(onFailure.mock.calls[0][2]).toEqual(errors);
    });

    it('push failure (fast_forward_required) → returns error, fires onSettleFailure', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const pushFails: PushToMainFn = async () => ({
            ok: false,
            error: 'fast_forward_required',
            currentSha: 'aaa',
        });
        const onFailure = vi.fn(async () => {});
        const ctx = makeCtx({ pushToMain: pushFails, hooks: { onSettleFailure: onFailure } });

        const r = await handleSettle(workdir, { message: 'add hr' }, ctx);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('fast_forward_required');
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onFailure.mock.calls[0][1]).toBe('fast_forward_required');
    });

    it('onSettleSuccess throw is caught and logged; settle result is unchanged', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const log = makeLog();
        const onSuccess = vi.fn(async () => {
            throw new Error('audit redis down');
        });
        const ctx = makeCtx({ log, hooks: { onSettleSuccess: onSuccess } });

        const r = await handleSettle(workdir, { message: 'add hr' }, ctx);
        expect(r.ok).toBe(true);
        expect(log.warn).toHaveBeenCalledWith('onSettleSuccess hook failed', expect.objectContaining({ errorMessage: 'audit redis down' }));
    });

    it('onSettleFailure throw is caught and logged; settle result is unchanged', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# bad\n'));

        const log = makeLog();
        const onFailure = vi.fn(async () => {
            throw new Error('audit redis down');
        });
        const ctx = makeCtx({
            log,
            lint: denyLint([{ code: 'bad', message: 'no' }]),
            hooks: { onSettleFailure: onFailure },
        });

        const r = await handleSettle(workdir, { message: 'add hr' }, ctx);
        expect(r.ok).toBe(false);
        expect(log.warn).toHaveBeenCalledWith('onSettleFailure hook failed', expect.objectContaining({ errorMessage: 'audit redis down' }));
    });

    it('invalid input: empty message returns invalid_input', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const r = await handleSettle(workdir, { message: '' } as any, makeCtx());
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('invalid_input');
    });

    it('invalid input: > 500-char message returns invalid_input', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const longMsg = 'x'.repeat(501);
        const r = await handleSettle(workdir, { message: longMsg }, makeCtx());
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('invalid_input');
    });

    it('nothing to settle → returns lint_failed with nothing_to_settle code', async () => {
        const workdir = buildWorkdir();
        // No working-tree changes at all.

        const onFailure = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleFailure: onFailure } });

        const r = await handleSettle(workdir, { message: 'noop' }, ctx);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('lint_failed');
        if (r.error !== 'lint_failed') return;
        expect(r.errors[0].code).toBe('nothing_to_settle');
        expect(onFailure).toHaveBeenCalledTimes(1);
        expect(onFailure.mock.calls[0][0]).toEqual([]);
    });

    it('fast_forward_required → fetches origin/main, rebases, retries push once and succeeds', async () => {
        // This test models the wave-6 race: the derive worker's startup-sweep
        // landed a commit on origin/main between our local commit and the bot
        // push. The first push is rejected as non-FF; settle must refresh
        // from origin/main, replay the commit, and retry — exactly once.

        // Set up a bare origin with one extra commit beyond what the workdir
        // sees, so `git fetch origin main` actually advances FETCH_HEAD.
        const bareRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-verbs-settle-origin-'));
        try {
            await runGit(bareRoot, ['init', '-q', '--bare', '-b', 'main']);

            // Seed bare from the workdir's initial commit so they share history.
            await runGit(tmpRoot, ['remote', 'add', 'origin', bareRoot]);
            await runGit(tmpRoot, ['push', '-q', 'origin', 'main']);

            // Add the "concurrent worker" commit on origin/main via a side clone.
            const sideRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-verbs-settle-side-'));
            try {
                await runGit(sideRoot, ['clone', '-q', '-b', 'main', bareRoot, '.']);
                await runGit(sideRoot, ['config', 'user.email', 'worker@example.com']);
                await runGit(sideRoot, ['config', 'user.name', 'Worker']);
                await runGit(sideRoot, ['config', 'commit.gpgsign', 'false']);
                await runGit(sideRoot, ['commit', '-q', '--allow-empty', '-m', 'worker startup-sweep']);
                await runGit(sideRoot, ['push', '-q', 'origin', 'main']);
            } finally {
                await rm(sideRoot, { recursive: true, force: true });
            }

            const workdir = buildWorkdir();
            await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

            let pushCalls = 0;
            const pushOnceFailThenOk: PushToMainFn = async ({ sha }) => {
                pushCalls += 1;
                if (pushCalls === 1) {
                    return { ok: false, error: 'fast_forward_required', currentSha: 'aaa' };
                }
                return { ok: true, sha };
            };

            const log = makeLog();
            const onSuccess = vi.fn(async () => {});
            const ctx = makeCtx({
                log,
                pushToMain: pushOnceFailThenOk,
                hooks: { onSettleSuccess: onSuccess },
            });

            const r = await handleSettle(workdir, { message: 'add hr' }, ctx);

            expect(r.ok).toBe(true);
            if (!r.ok) return;
            expect(r.pushed).toBe(true);
            expect(pushCalls).toBe(2);
            expect(onSuccess).toHaveBeenCalledTimes(1);
            expect(log.info).toHaveBeenCalledWith(
                expect.stringContaining('non-fast-forward'),
                expect.objectContaining({ workdirId: 'wd1' }),
            );
        } finally {
            await rm(bareRoot, { recursive: true, force: true });
        }
    });

    it('applies trailers when supplied', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const ctx = makeCtx({
            trailers: { 'Workdir-Id': 'wd1', User: 'u@b.com', Transport: 'in-process' },
        });

        const r = await handleSettle(workdir, { message: 'add hr' }, ctx);
        expect(r.ok).toBe(true);
        const log = await runGit(tmpRoot, ['log', '-1', '--format=%B']);
        expect(log).toContain('Workdir-Id: wd1');
        expect(log).toContain('Transport: in-process');
    });
});
