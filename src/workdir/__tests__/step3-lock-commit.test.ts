import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { commitTurn } from '../commit-turn';
import { rehydrateWorkdir } from '../boot';
import { runGit } from '../run-git';
import { makeNodeFsAdapter } from '../node-adapters';
import { makeInMemoryWorkdirLock } from '../lock';

describe('commitTurn — lock serializes concurrent calls on the same workdirId', () => {
    let tmpRoot: string;

    beforeEach(async () => {
        tmpRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-commit-'));
        await runGit(tmpRoot, ['init', '-q', '-b', 'main']);
        await runGit(tmpRoot, ['config', 'user.email', 'poc@bitrefill.com']);
        await runGit(tmpRoot, ['config', 'user.name', 'PoC']);
        await runGit(tmpRoot, ['config', 'commit.gpgsign', 'false']);
        await runGit(tmpRoot, ['commit', '-q', '--allow-empty', '-m', 'init']);
    });

    afterEach(async () => {
        await rm(tmpRoot, { recursive: true, force: true });
    });

    function buildWorkdir(workdirId: string) {
        return rehydrateWorkdir({
            workdirId, tier: 'managed', workingTreeRoot: tmpRoot,
            fs: makeNodeFsAdapter(tmpRoot),
            master: { resolve: async () => ({ kind: 'not-found' }) },
            lock: makeInMemoryWorkdirLock(workdirId),
        });
    }

    it('two concurrent commitTurns both land; both have distinct shas', async () => {
        const workdir = buildWorkdir('wd1');

        const a = commitTurn(workdir, {
            paths: ['a.txt'], message: 'add a',
            files: [{ path: 'a.txt', content: new TextEncoder().encode('A\n') }],
        });
        const b = commitTurn(workdir, {
            paths: ['b.txt'], message: 'add b',
            files: [{ path: 'b.txt', content: new TextEncoder().encode('B\n') }],
        });

        const [resA, resB] = await Promise.all([a, b]);
        expect(resA.sha).toBeTruthy();
        expect(resB.sha).toBeTruthy();
        expect(resA.sha).not.toBe(resB.sha);

        const log = await runGit(tmpRoot, ['log', '--format=%s']);
        expect(log).toContain('add a');
        expect(log).toContain('add b');
    });

    it('serializes 10 concurrent commitTurns; final log has all 10 commits in order', async () => {
        const workdir = buildWorkdir('wd-many');

        const calls = Array.from({ length: 10 }, (_, i) =>
            commitTurn(workdir, {
                paths: [`f${i}.txt`], message: `commit ${i}`,
                files: [{ path: `f${i}.txt`, content: new TextEncoder().encode(`${i}\n`) }],
            })
        );

        const results = await Promise.all(calls);
        const shas = new Set(results.map(r => r.sha));
        expect(shas.size).toBe(10);

        const log = await runGit(tmpRoot, ['log', '--format=%s', '--reverse']);
        const lines = log.trim().split('\n').filter(l => l.startsWith('commit '));
        expect(lines).toHaveLength(10);
        for (let i = 0; i < 10; i++) {
            expect(lines[i]).toBe(`commit ${i}`);
        }
    });

    it('an error in one call does not block subsequent calls on the same workdirId', async () => {
        const workdir = buildWorkdir('wd-err');

        const willFail = commitTurn(workdir, {
            paths: ['nonexistent.txt'],
            message: 'will fail',
        });
        const willSucceed = commitTurn(workdir, {
            paths: ['ok.txt'], message: 'ok',
            files: [{ path: 'ok.txt', content: new TextEncoder().encode('ok\n') }],
        });

        await expect(willFail).rejects.toThrow();
        const ok = await willSucceed;
        expect(ok.sha).toBeTruthy();

        const log = await runGit(tmpRoot, ['log', '--format=%s']);
        expect(log).toContain('ok');
        expect(log).not.toContain('will fail');
    });
});
