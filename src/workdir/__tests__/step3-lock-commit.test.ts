import { describe, it, expect } from 'vitest';
import { commitTurn } from '../commit-turn';
import { runGit } from '../run-git';
import { buildWorkdir } from '../../__tests__/kit';

describe('commitTurn — lock serializes concurrent calls on the same workdirId', () => {
    it('two concurrent commitTurns both land; both have distinct shas', async () => {
        const { workdir, root, cleanup } = await buildWorkdir({ workdirId: 'wd1' });
        try {
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

            const log = await runGit(root, ['log', '--format=%s']);
            expect(log).toContain('add a');
            expect(log).toContain('add b');
        } finally {
            await cleanup();
        }
    });

    it('serializes 10 concurrent commitTurns; final log has all 10 commits in order', async () => {
        const { workdir, root, cleanup } = await buildWorkdir({ workdirId: 'wd-many' });
        try {
            const calls = Array.from({ length: 10 }, (_, i) =>
                commitTurn(workdir, {
                    paths: [`f${i}.txt`], message: `commit ${i}`,
                    files: [{ path: `f${i}.txt`, content: new TextEncoder().encode(`${i}\n`) }],
                })
            );

            const results = await Promise.all(calls);
            const shas = new Set(results.map(r => r.sha));
            expect(shas.size).toBe(10);

            const log = await runGit(root, ['log', '--format=%s', '--reverse']);
            const lines = log.trim().split('\n').filter(l => l.startsWith('commit '));
            expect(lines).toHaveLength(10);
            for (let i = 0; i < 10; i++) {
                expect(lines[i]).toBe(`commit ${i}`);
            }
        } finally {
            await cleanup();
        }
    });

    it('an error in one call does not block subsequent calls on the same workdirId', async () => {
        const { workdir, root, cleanup } = await buildWorkdir({ workdirId: 'wd-err' });
        try {
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

            const log = await runGit(root, ['log', '--format=%s']);
            expect(log).toContain('ok');
            expect(log).not.toContain('will fail');
        } finally {
            await cleanup();
        }
    });
});
