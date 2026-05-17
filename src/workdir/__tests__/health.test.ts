/**
 * Unit tests for the shared workdir health probe + bootstrap.
 *
 * Same field bug pinned twice (once Tier-A, once Tier-C — see
 * `src/ernesto/domains/workspaces/README.md` §22 "the repos today"): on
 * macOS dev `/var/folders/.../T/` and `/tmp` get aperiodically pruned,
 * selectively deleting static `.git/` files (HEAD, config) while leaving
 * `FETCH_HEAD`/`ORIG_HEAD`/`index` intact. Git then rejects the directory
 * with "fatal: not a git repository," and any operation that runs
 * `git fetch` first dies with a misleading error.
 *
 * The fix is one shared probe + one shared bootstrap in the lib; per-tier
 * recovery policy (silent self-heal on Tier A, fail-loud on Tier C
 * unless --force) sits at the call site.
 */
import { describe, it, expect } from 'vitest';
import { promises as fsp, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { probeWorkdirHealth, bootstrapWorkdir } from '../health';

const pExecFile = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await pExecFile('git', args, { cwd });
    return stdout;
}

async function makeBareOrigin(): Promise<{ tmp: string; origin: string }> {
    const tmp = mkdtempSync(join(tmpdir(), 'ernesto-lib-health-'));
    const origin = join(tmp, 'origin.git');
    await fsp.mkdir(origin, { recursive: true });
    await git(origin, ['init', '--bare', '-b', 'main']);
    const seed = join(tmp, 'seed');
    await fsp.mkdir(seed, { recursive: true });
    await git(seed, ['init', '-b', 'main']);
    await git(seed, ['config', 'user.email', 't@b.com']);
    await git(seed, ['config', 'user.name', 't']);
    await git(seed, ['config', 'commit.gpgsign', 'false']);
    await fsp.writeFile(join(seed, 'README.md'), 'init\n');
    await git(seed, ['add', '-A']);
    await git(seed, ['commit', '-q', '-m', 'init']);
    await git(seed, ['remote', 'add', 'origin', origin]);
    await git(seed, ['push', '-q', 'origin', 'main']);
    return { tmp, origin };
}

describe('probeWorkdirHealth', () => {
    it('returns "missing" when the directory has no .git', async () => {
        const tmp = mkdtempSync(join(tmpdir(), 'ernesto-lib-probe-'));
        const res = await probeWorkdirHealth(tmp);
        expect(res).toBe('missing');
    });

    it('returns "healthy" for a fresh clone', async () => {
        const { tmp, origin } = await makeBareOrigin();
        const root = join(tmp, 'clone');
        await fsp.mkdir(root, { recursive: true });
        await git(root, ['clone', '--branch', 'main', '--single-branch', origin, '.']);
        expect(await probeWorkdirHealth(root)).toBe('healthy');
    });

    it('returns "corrupted" when .git/HEAD and .git/config are missing', async () => {
        const { tmp, origin } = await makeBareOrigin();
        const root = join(tmp, 'clone');
        await fsp.mkdir(root, { recursive: true });
        await git(root, ['clone', '--branch', 'main', '--single-branch', origin, '.']);

        // Reproduce the macOS-pruning field case: directory still has
        // refs/, objects/, index, FETCH_HEAD — but HEAD and config gone.
        await fsp.rm(join(root, '.git', 'HEAD'), { force: true });
        await fsp.rm(join(root, '.git', 'config'), { force: true });

        expect(await probeWorkdirHealth(root)).toBe('corrupted');
    });
});

describe('bootstrapWorkdir', () => {
    it('clones into an empty directory and applies post-clone git config', async () => {
        const { tmp, origin } = await makeBareOrigin();
        const root = join(tmp, 'fresh');

        await bootstrapWorkdir({
            workingTreeRoot: root,
            repoUrl: origin,
            branch: 'main',
            gitConfig: {
                'user.email': 'ernesto-bot@bitrefill.com',
                'user.name': 'Ernesto',
                'commit.gpgsign': 'false',
            },
        });

        expect(await probeWorkdirHealth(root)).toBe('healthy');
        const email = (await git(root, ['config', 'user.email'])).trim();
        expect(email).toBe('ernesto-bot@bitrefill.com');
        const sign = (await git(root, ['config', 'commit.gpgsign'])).trim();
        expect(sign).toBe('false');
    });

    it('wipes a corrupted clone and re-clones cleanly', async () => {
        const { tmp, origin } = await makeBareOrigin();
        const root = join(tmp, 'broken');
        await fsp.mkdir(root, { recursive: true });
        await git(root, ['clone', '--branch', 'main', '--single-branch', origin, '.']);

        // Corrupt it.
        await fsp.rm(join(root, '.git', 'HEAD'), { force: true });
        await fsp.rm(join(root, '.git', 'config'), { force: true });
        expect(await probeWorkdirHealth(root)).toBe('corrupted');

        // Bootstrap is destructive but recovers.
        await bootstrapWorkdir({
            workingTreeRoot: root,
            repoUrl: origin,
            branch: 'main',
        });

        expect(await probeWorkdirHealth(root)).toBe('healthy');
    });

    it('depth: 1 produces a shallow clone with exactly one walkable commit', async () => {
        // Seed origin with multiple commits so the difference between
        // shallow and full is observable.
        const { tmp, origin } = await makeBareOrigin();
        const second = join(tmp, 'seed2');
        await fsp.mkdir(second, { recursive: true });
        await git(second, ['clone', '--branch', 'main', '--single-branch', origin, '.']);
        await git(second, ['config', 'user.email', 't@b.com']);
        await git(second, ['config', 'user.name', 't']);
        await git(second, ['config', 'commit.gpgsign', 'false']);
        for (let i = 0; i < 3; i++) {
            await fsp.writeFile(join(second, `f${i}.txt`), `content ${i}\n`);
            await git(second, ['add', '-A']);
            await git(second, ['commit', '-q', '-m', `commit ${i}`]);
        }
        await git(second, ['push', '-q', 'origin', 'main']);

        const root = join(tmp, 'shallow');
        // Git silently ignores `--depth` for local-protocol clones. The
        // `file://` URL forces the remote protocol so the shallow flag
        // actually applies — production uses https:// which respects it.
        await bootstrapWorkdir({
            workingTreeRoot: root,
            repoUrl: `file://${origin}`,
            branch: 'main',
            depth: 1,
        });

        expect(await probeWorkdirHealth(root)).toBe('healthy');
        const count = (await git(root, ['rev-list', '--count', 'HEAD'])).trim();
        expect(count).toBe('1');
    });

    it('omitting depth yields a full clone (full history walkable)', async () => {
        const { tmp, origin } = await makeBareOrigin();
        const second = join(tmp, 'seed2');
        await fsp.mkdir(second, { recursive: true });
        await git(second, ['clone', '--branch', 'main', '--single-branch', origin, '.']);
        await git(second, ['config', 'user.email', 't@b.com']);
        await git(second, ['config', 'user.name', 't']);
        await git(second, ['config', 'commit.gpgsign', 'false']);
        for (let i = 0; i < 3; i++) {
            await fsp.writeFile(join(second, `f${i}.txt`), `content ${i}\n`);
            await git(second, ['add', '-A']);
            await git(second, ['commit', '-q', '-m', `commit ${i}`]);
        }
        await git(second, ['push', '-q', 'origin', 'main']);

        const root = join(tmp, 'full');
        await bootstrapWorkdir({
            workingTreeRoot: root,
            repoUrl: origin,
            branch: 'main',
        });

        expect(await probeWorkdirHealth(root)).toBe('healthy');
        const count = parseInt((await git(root, ['rev-list', '--count', 'HEAD'])).trim(), 10);
        expect(count).toBeGreaterThan(1);
    });
});
