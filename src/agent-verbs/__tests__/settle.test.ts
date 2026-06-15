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

    it('happy path: derives workspaces from selected files, pushes, fires onSettleSuccess', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const onSuccess = vi.fn(async () => {});
        const onFailure = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleSuccess: onSuccess, onSettleFailure: onFailure } });

        const r = await handleSettle(workdir, { message: 'add hr', files: ['workspaces/hr/WORKSPACE.md'] }, ctx);

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

    it('derives multiple workspaces from a multi-workspace selection', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));
        await workdir.fs.writeFile('workspaces/cs/WORKSPACE.md', enc('# cs\n'));

        const onSuccess = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleSuccess: onSuccess } });

        const r = await handleSettle(
            workdir,
            { message: 'add hr + cs', files: ['workspaces/hr/WORKSPACE.md', 'workspaces/cs/WORKSPACE.md'] },
            ctx,
        );
        expect(r.ok).toBe(true);
        expect(onSuccess.mock.calls[0][0]).toEqual(['cs', 'hr']); // sorted
    });

    it('derives the workspace for a selected attachments.yaml change; still ignores attached/', async () => {
        const workdir = buildWorkdir();
        // attachments.yaml is now a tracked, draftable file — author intent — so
        // a selected yaml DOES pull its workspace into the settle set. The
        // `attached/` byte mirror stays invisible: never author intent, so even
        // when named in the selection it contributes no workspace.
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));
        await workdir.fs.writeFile('workspaces/_tmp/attachments.yaml', enc('[]\n'));
        await workdir.fs.writeFile('workspaces/_ernesto/attached/note.txt', enc('y\n'));

        const onSuccess = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleSuccess: onSuccess } });

        const r = await handleSettle(
            workdir,
            {
                message: 'edit hr',
                files: ['workspaces/hr/WORKSPACE.md', 'workspaces/_tmp/attachments.yaml', 'workspaces/_ernesto/attached/note.txt'],
            },
            ctx,
        );
        expect(r.ok).toBe(true);
        expect(onSuccess.mock.calls[0][0]).toEqual(['_tmp', 'hr']); // sorted
    });

    it('a selection of only out-of-workspace paths is refused (selection_required)', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const onSuccess = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleSuccess: onSuccess } });

        // README.md is not under workspaces/<name>/ — settle only touches those.
        const r = await handleSettle(workdir, { message: 'add readme', files: ['README.md'] }, ctx);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('selection_required');
        expect(onSuccess).not.toHaveBeenCalled();
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

        const r = await handleSettle(workdir, { message: 'add hr', files: ['workspaces/hr/WORKSPACE.md'] }, ctx);

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

        const r = await handleSettle(workdir, { message: 'add hr', files: ['workspaces/hr/WORKSPACE.md'] }, ctx);
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

        const r = await handleSettle(workdir, { message: 'add hr', files: ['workspaces/hr/WORKSPACE.md'] }, ctx);
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

        const r = await handleSettle(workdir, { message: 'add hr', files: ['workspaces/hr/WORKSPACE.md'] }, ctx);
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
        const r = await handleSettle(workdir, { message: longMsg, files: ['workspaces/hr/WORKSPACE.md'] }, makeCtx());
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('invalid_input');
    });

    it('absent files → selection_required, lists the current draft paths, no settle', async () => {
        const workdir = buildWorkdir();
        // The agent has a draft (edited hr) but called settle with no selection.
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const onSuccess = vi.fn(async () => {});
        const onFailure = vi.fn(async () => {});
        const ctx = makeCtx({ hooks: { onSettleSuccess: onSuccess, onSettleFailure: onFailure } });

        const r = await handleSettle(workdir, { message: 'noop' } as any, ctx);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('selection_required');
        if (r.error !== 'selection_required') return;
        // The refusal lists the agent's actual draft so it can re-select.
        expect(r.draft).toContain('workspaces/hr/WORKSPACE.md');
        expect(r.message).toContain('choose which files to publish');
        // No settle happened, and the failure hook is NOT fired for a refusal.
        expect(onSuccess).not.toHaveBeenCalled();
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('empty files array → selection_required', async () => {
        const workdir = buildWorkdir();
        await workdir.fs.writeFile('workspaces/hr/WORKSPACE.md', enc('# hr\n'));

        const r = await handleSettle(workdir, { message: 'noop', files: [] }, makeCtx());
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.error).toBe('selection_required');
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

            const r = await handleSettle(workdir, { message: 'add hr', files: ['workspaces/hr/WORKSPACE.md'] }, ctx);

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

        const r = await handleSettle(workdir, { message: 'add hr', files: ['workspaces/hr/WORKSPACE.md'] }, ctx);
        expect(r.ok).toBe(true);
        const log = await runGit(tmpRoot, ['log', '-1', '--format=%B']);
        expect(log).toContain('Workdir-Id: wd1');
        expect(log).toContain('Transport: in-process');
    });
});
