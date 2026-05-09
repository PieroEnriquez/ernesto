import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { bootWorkdir } from '../boot';
import { makeNodeFsAdapter, makeVolumeMasterFs } from '../node-adapters';
import { makeInMemoryFsAdapter, makeInMemoryMasterFs } from '../in-memory-adapters';
import { makeInMemoryWorkdirLock } from '../lock';
import { LayoutEntry } from '../types';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

const FIXTURE: ReadonlyArray<{ path: string; content: string }> = [
    { path: 'workspaces/hr/routes/_index.md', content: '# routes for hr\n' },
    { path: 'workspaces/hr/INDEX.md', content: '# hr\n' },
    { path: 'workspaces/hr/extracted/_index.md', content: '# extracted for hr\n' },
    { path: 'workspaces/cs/INDEX.md', content: '# cs\n' },
];

const LAYOUT: ReadonlyArray<LayoutEntry> = FIXTURE.map(f => ({
    workspace: f.path.split('/')[1],
    masterFsPath: f.path,
    treePath: f.path,
}));

describe('bootWorkdir — node adapter ↔ in-memory parity', () => {
    let tmpRoot: string;
    let masterFsRoot: string;
    let workingTreeRoot: string;

    beforeEach(async () => {
        tmpRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-poc-'));
        masterFsRoot = path.join(tmpRoot, 'master-fs');
        workingTreeRoot = path.join(tmpRoot, 'wt');
        await mkdir(masterFsRoot, { recursive: true });
        await mkdir(workingTreeRoot, { recursive: true });

        for (const f of FIXTURE) {
            const abs = path.join(masterFsRoot, f.path);
            await mkdir(path.dirname(abs), { recursive: true });
            await writeFile(abs, f.content);
        }
    });

    afterEach(async () => {
        await rm(tmpRoot, { recursive: true, force: true });
    });

    it('real adapter pair lays out symlinks; reads resolve to fixture bytes', async () => {
        const fs = makeNodeFsAdapter(workingTreeRoot);
        const master = makeVolumeMasterFs(masterFsRoot);

        const result = await bootWorkdir({
            workdirId: 'wd-real', tier: 'managed', workingTreeRoot,
            fs, master, lock: makeInMemoryWorkdirLock('wd-real'),
            visibleWorkspaces: ['hr', 'cs'],
            layout: LAYOUT,
        });

        expect(result.placed.every(p => p.kind === 'symlink')).toBe(true);
        expect(result.placed).toHaveLength(4);

        for (const f of FIXTURE) {
            expect(dec(await fs.readFile(f.path))).toBe(f.content);
        }
    });

    it('in-memory adapter pair (bytes mode) yields the same content per path', async () => {
        const fs = makeInMemoryFsAdapter();
        const master = makeInMemoryMasterFs({
            bytes: new Map(FIXTURE.map(f => [f.path, enc(f.content)])),
        });

        const result = await bootWorkdir({
            workdirId: 'wd-mem', tier: 'remote-fs', workingTreeRoot: '/wt',
            fs, master, lock: makeInMemoryWorkdirLock('wd-mem'),
            visibleWorkspaces: ['hr', 'cs'],
            layout: LAYOUT,
        });

        expect(result.placed.every(p => p.kind === 'bytes')).toBe(true);

        for (const f of FIXTURE) {
            expect(dec(await fs.readFile(f.path))).toBe(f.content);
        }
    });

    it('parity: same fixtures + same layout → same byte content per path on both adapter pairs', async () => {
        const realFs = makeNodeFsAdapter(workingTreeRoot);
        await bootWorkdir({
            workdirId: 'a', tier: 'managed', workingTreeRoot,
            fs: realFs, master: makeVolumeMasterFs(masterFsRoot),
            lock: makeInMemoryWorkdirLock('a'),
            visibleWorkspaces: ['hr', 'cs'], layout: LAYOUT,
        });

        const memFs = makeInMemoryFsAdapter();
        await bootWorkdir({
            workdirId: 'b', tier: 'remote-fs', workingTreeRoot: '/wt',
            fs: memFs,
            master: makeInMemoryMasterFs({
                bytes: new Map(FIXTURE.map(f => [f.path, enc(f.content)])),
            }),
            lock: makeInMemoryWorkdirLock('b'),
            visibleWorkspaces: ['hr', 'cs'], layout: LAYOUT,
        });

        for (const f of FIXTURE) {
            const realContent = dec(await realFs.readFile(f.path));
            const memContent = dec(await memFs.readFile(f.path));
            expect(realContent).toBe(memContent);
            expect(realContent).toBe(f.content);
        }

        for (const f of FIXTURE) {
            expect(await realFs.exists(f.path)).toBe(true);
            expect(await memFs.exists(f.path)).toBe(true);
        }
    });
});
