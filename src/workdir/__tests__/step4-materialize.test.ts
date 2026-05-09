import { describe, it, expect } from 'vitest';
import { rehydrateWorkdir } from '../boot';
import { materializeFile } from '../materialize';
import { makeInMemoryFsAdapter, makeInMemoryMasterFs } from '../in-memory-adapters';
import { makeInMemoryWorkdirLock } from '../lock';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function buildWorkdir(opts: {
    bytes?: Map<string, Uint8Array>;
    symlinkRoot?: string;
}) {
    const fs = makeInMemoryFsAdapter();
    const master = makeInMemoryMasterFs(opts);
    const workdir = rehydrateWorkdir({
        workdirId: 'wd1', tier: 'local-fs', workingTreeRoot: '/wt',
        fs, master, lock: makeInMemoryWorkdirLock('wd1'),
    });
    return { workdir, fs, master };
}

describe('materializeFile', () => {
    it('writes bytes when master FS resolves to bytes and tree path is empty', async () => {
        const { workdir, fs } = buildWorkdir({
            bytes: new Map([['workspaces/hr/extracted/a.md', enc('# a\n')]]),
        });

        const r = await materializeFile(workdir, {
            treePath: 'workspaces/hr/extracted/a.md',
            masterFsPath: 'workspaces/hr/extracted/a.md',
        });

        expect(r).toEqual({ kind: 'placed', placement: 'bytes' });
        expect(dec(await fs.readFile('workspaces/hr/extracted/a.md'))).toBe('# a\n');
    });

    it('creates a symlink when master FS resolves to a symlink', async () => {
        const { workdir, fs } = buildWorkdir({
            symlinkRoot: '/master-fs',
            bytes: new Map([['workspaces/hr/INDEX.md', enc('# hr\n')]]),
        });

        const r = await materializeFile(workdir, {
            treePath: 'workspaces/hr/INDEX.md',
            masterFsPath: 'workspaces/hr/INDEX.md',
        });

        expect(r).toEqual({ kind: 'placed', placement: 'symlink' });
        expect(await fs.exists('workspaces/hr/INDEX.md')).toBe(true);
    });

    it('is a no-op when the tree path is already present', async () => {
        const { workdir, fs } = buildWorkdir({
            bytes: new Map([['workspaces/hr/INDEX.md', enc('# hr (master)\n')]]),
        });
        await fs.writeFile('workspaces/hr/INDEX.md', enc('# hr (local)\n'));

        const r = await materializeFile(workdir, {
            treePath: 'workspaces/hr/INDEX.md',
            masterFsPath: 'workspaces/hr/INDEX.md',
        });

        expect(r).toEqual({ kind: 'already-present' });
        expect(dec(await fs.readFile('workspaces/hr/INDEX.md'))).toBe('# hr (local)\n');
    });

    it('returns not-found when master FS has no such path', async () => {
        const { workdir, fs } = buildWorkdir({ bytes: new Map() });

        const r = await materializeFile(workdir, {
            treePath: 'workspaces/hr/missing.md',
            masterFsPath: 'workspaces/hr/missing.md',
        });

        expect(r).toEqual({ kind: 'not-found' });
        expect(await fs.exists('workspaces/hr/missing.md')).toBe(false);
    });
});
