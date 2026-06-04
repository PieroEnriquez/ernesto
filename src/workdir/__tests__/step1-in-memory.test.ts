import { describe, it, expect } from 'vitest';
import { bootWorkdir } from '../boot';
import { makeInMemoryFsAdapter, makeInMemoryMasterFs } from '../in-memory-adapters';
import { makeInMemoryWorkdirLock } from '../lock';
import { LayoutEntry } from '../types';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const FIXTURE_LAYOUT: ReadonlyArray<LayoutEntry> = [
    { workspace: 'hr', masterFsPath: 'workspaces/hr/routes/_index.md', treePath: 'workspaces/hr/routes/_index.md' },
    { workspace: 'hr', masterFsPath: 'workspaces/hr/INDEX.md', treePath: 'workspaces/hr/INDEX.md' },
    { workspace: 'hr', masterFsPath: 'workspaces/hr/extracted/_index.md', treePath: 'workspaces/hr/extracted/_index.md' },
    { workspace: 'legal', masterFsPath: 'workspaces/legal/INDEX.md', treePath: 'workspaces/legal/INDEX.md' },
    { workspace: 'cs', masterFsPath: 'workspaces/cs/INDEX.md', treePath: 'workspaces/cs/INDEX.md' },
];

const FIXTURE_BYTES = new Map<string, Uint8Array>([
    ['workspaces/hr/routes/_index.md', enc('# routes for hr\n')],
    ['workspaces/hr/INDEX.md', enc('# hr\n')],
    ['workspaces/hr/extracted/_index.md', enc('# extracted for hr\n')],
    ['workspaces/legal/INDEX.md', enc('# legal\n')],
    ['workspaces/cs/INDEX.md', enc('# cs\n')],
]);

describe('bootWorkdir — in-memory adapter pair (bytes mode)', () => {
    it('lays out only visible workspaces', async () => {
        const fs = makeInMemoryFsAdapter();
        const master = makeInMemoryMasterFs({ bytes: FIXTURE_BYTES });

        const result = await bootWorkdir({
            workdirId: 'wd1',
            workingTreeRoot: '/wt',
            fs, master,
            lock: makeInMemoryWorkdirLock('wd1'),
            visibleWorkspaces: ['hr', 'cs'],
            layout: FIXTURE_LAYOUT,
        });

        expect(result.placed.map(p => p.treePath).sort()).toEqual([
            'workspaces/cs/INDEX.md',
            'workspaces/hr/INDEX.md',
            'workspaces/hr/extracted/_index.md',
            'workspaces/hr/routes/_index.md',
        ]);
        expect(result.placed.every(p => p.kind === 'bytes')).toBe(true);

        expect(await result.workdir.fs.exists('workspaces/hr/INDEX.md')).toBe(true);
        expect(await result.workdir.fs.exists('workspaces/cs/INDEX.md')).toBe(true);
        expect(await result.workdir.fs.exists('workspaces/legal/INDEX.md')).toBe(false);

        expect(dec(await result.workdir.fs.readFile('workspaces/hr/INDEX.md'))).toBe('# hr\n');
        expect(dec(await result.workdir.fs.readFile('workspaces/cs/INDEX.md'))).toBe('# cs\n');
    });

    it('produces a Workdir with branchRef = refs/workdirs/{wdid}', async () => {
        const { workdir } = await bootWorkdir({
            workdirId: 'wd-xyz',
            workingTreeRoot: '/wt',
            fs: makeInMemoryFsAdapter(),
            master: makeInMemoryMasterFs({ bytes: new Map() }),
            lock: makeInMemoryWorkdirLock('wd-xyz'),
            visibleWorkspaces: [],
            layout: [],
        });
        expect(workdir.branchRef).toBe('refs/workdirs/wd-xyz');
        expect(workdir.workdirId).toBe('wd-xyz');
    });

    it('skips entries that are not-found in master FS', async () => {
        const fs = makeInMemoryFsAdapter();
        const master = makeInMemoryMasterFs({
            bytes: new Map([['workspaces/hr/INDEX.md', enc('# hr\n')]]),
        });

        const result = await bootWorkdir({
            workdirId: 'wd1', workingTreeRoot: '/wt',
            fs, master, lock: makeInMemoryWorkdirLock('wd1'),
            visibleWorkspaces: ['hr'],
            layout: [
                { workspace: 'hr', masterFsPath: 'workspaces/hr/INDEX.md', treePath: 'workspaces/hr/INDEX.md' },
                { workspace: 'hr', masterFsPath: 'workspaces/hr/MISSING.md', treePath: 'workspaces/hr/MISSING.md' },
            ],
        });

        expect(result.placed).toHaveLength(1);
        expect(await fs.exists('workspaces/hr/INDEX.md')).toBe(true);
        expect(await fs.exists('workspaces/hr/MISSING.md')).toBe(false);
    });
});

describe('bootWorkdir — in-memory adapter pair (hardlink mode)', () => {
    it('records hardlinks instead of bytes when master FS resolves to hardlinks', async () => {
        const fs = makeInMemoryFsAdapter();
        // In-memory `link()` reads bytes from the source path, so pre-seed
        // the source files under the same hardlinkSourceRoot the master-fs
        // adapter will return.
        for (const [p, content] of FIXTURE_BYTES) {
            await fs.writeFile(`/master-fs/${p}`, content);
        }
        const master = makeInMemoryMasterFs({
            hardlinkSourceRoot: '/master-fs',
            bytes: FIXTURE_BYTES,
        });

        const result = await bootWorkdir({
            workdirId: 'wd1', workingTreeRoot: '/wt',
            fs, master, lock: makeInMemoryWorkdirLock('wd1'),
            visibleWorkspaces: ['hr'],
            layout: FIXTURE_LAYOUT,
        });

        expect(result.placed.every(p => p.kind === 'hardlink')).toBe(true);
        expect(result.placed).toHaveLength(3);
    });
});
