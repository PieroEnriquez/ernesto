/**
 * Shared workdir scaffolding for the lib suite.
 *
 * Pure test scaffolding over the workdir internals (imported by relative path,
 * since the kit lives inside the package). It is the canonical body the
 * step3/step5/step6/settle-from/agent-verbs/parity suites each re-create:
 *   - `buildWorkdir`  — mkdtemp + optional `git init -b main` + empty commit +
 *                       node FS adapter + rehydrate + in-memory lock
 *                       (+ volume master-FS when `withMaster`).
 *   - `setupBareRepo` — bare upstream + seed clone + commit + push (the
 *                       origin-backed shape step6/build-patch/health need).
 *   - `makeTempTree`  — mkdtemp + write files, returns dir + node FS adapter
 *                       (the FsAdapter-only half for glob-grep's re-creations).
 *   - `seedWorkspace` — write `workspaces/<name>/WORKSPACE.md` (lint-workspace).
 */
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { rehydrateWorkdir } from '../../workdir/boot';
import { makeNodeFsAdapter, makeVolumeMasterFs } from '../../workdir/node-adapters';
import { makeInMemoryWorkdirLock } from '../../workdir/lock';
import { runGit } from '../../workdir/run-git';
import type { Workdir, FsAdapter } from '../../workdir/types';

const NOT_FOUND_MASTER = { resolve: async () => ({ kind: 'not-found' as const }) };

export interface BuildWorkdirOpts {
    prefix?: string;
    /** runGit init -q -b main + identity + empty commit. Default true. */
    gitInit?: boolean;
    /** masterFsRoot for makeVolumeMasterFs. When omitted, master resolves not-found. */
    withMaster?: string;
    workdirId?: string;
}

export interface BuiltWorkdir {
    workdir: Workdir;
    fs: FsAdapter;
    root: string;
    workdirId: string;
    cleanup(): Promise<void>;
}

export async function buildWorkdir(opts: BuildWorkdirOpts = {}): Promise<BuiltWorkdir> {
    const { prefix = 'ernesto-wd-', gitInit = true, withMaster, workdirId = randomUUID() } = opts;
    const root = await mkdtemp(path.join(tmpdir(), prefix));

    if (gitInit) {
        await runGit(root, ['init', '-q', '-b', 'main']);
        await runGit(root, ['config', 'user.email', 'poc@example.com']);
        await runGit(root, ['config', 'user.name', 'PoC']);
        await runGit(root, ['config', 'commit.gpgsign', 'false']);
        await runGit(root, ['commit', '-q', '--allow-empty', '-m', 'init']);
    }

    const fs = makeNodeFsAdapter(root);
    const workdir = rehydrateWorkdir({
        workdirId,
        workingTreeRoot: root,
        fs,
        master: withMaster ? makeVolumeMasterFs(withMaster) : NOT_FOUND_MASTER,
        lock: makeInMemoryWorkdirLock(workdirId),
    });

    const cleanup = async () => {
        await rm(root, { recursive: true, force: true });
    };
    return { workdir, fs, root, workdirId, cleanup };
}

export interface BareRepo {
    bareRoot: string;
    cleanup(): Promise<void>;
}

/**
 * Bare upstream repo seeded with an initial main commit (via a throwaway seed
 * clone), for the origin-backed settle/journal-rebase suites. Extra seed files
 * may be supplied as treePath → content (relative to the repo root).
 */
export async function setupBareRepo(seedFiles: Record<string, string> = {}): Promise<BareRepo> {
    const bareRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-bare-'));
    await runGit(bareRoot, ['init', '-q', '--bare', '-b', 'main']);

    const seedRoot = await mkdtemp(path.join(tmpdir(), 'ernesto-seed-'));
    await runGit(seedRoot, ['init', '-q', '-b', 'main']);
    await runGit(seedRoot, ['config', 'user.email', 'poc@example.com']);
    await runGit(seedRoot, ['config', 'user.name', 'PoC']);
    await runGit(seedRoot, ['config', 'commit.gpgsign', 'false']);
    for (const [rel, content] of Object.entries(seedFiles)) {
        const abs = path.join(seedRoot, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content);
    }
    if (Object.keys(seedFiles).length > 0) {
        await runGit(seedRoot, ['add', '-A']);
        await runGit(seedRoot, ['commit', '-q', '-m', 'seed']);
    } else {
        await runGit(seedRoot, ['commit', '-q', '--allow-empty', '-m', 'init']);
    }
    await runGit(seedRoot, ['remote', 'add', 'origin', bareRoot]);
    await runGit(seedRoot, ['push', '-q', 'origin', 'main']);
    await rm(seedRoot, { recursive: true, force: true });

    const cleanup = async () => {
        await rm(bareRoot, { recursive: true, force: true });
    };
    return { bareRoot, cleanup };
}

export interface TempTree {
    dir: string;
    fs: FsAdapter;
    cleanup(): Promise<void>;
}

/**
 * mkdtemp + write `files` (treePath → content), returning the dir and a node
 * FS adapter rooted at it. The FsAdapter-only half for glob/grep tests.
 */
export async function makeTempTree(files: Record<string, string> = {}, prefix = 'ernesto-tree-'): Promise<TempTree> {
    const dir = await mkdtemp(path.join(tmpdir(), prefix));
    for (const [rel, content] of Object.entries(files)) {
        const abs = path.join(dir, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content);
    }
    const cleanup = async () => {
        await rm(dir, { recursive: true, force: true });
    };
    return { dir, fs: makeNodeFsAdapter(dir), cleanup };
}

/** Write `workspaces/<name>/WORKSPACE.md` with `body` under `root` (lint-workspace). */
export async function seedWorkspace(root: string, name: string, body: string): Promise<string> {
    const wsDir = path.join(root, 'workspaces', name);
    await mkdir(wsDir, { recursive: true });
    const file = path.join(wsDir, 'WORKSPACE.md');
    await writeFile(file, body);
    return file;
}
