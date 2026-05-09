/**
 * Workdir kernel — types.
 *
 * One value (`Workdir`) plus two adapter interfaces (`FsAdapter`,
 * `MasterFsAdapter`) and one mutex contract (`WorkdirLock`). All free
 * functions in the kernel take a `Workdir` and operate over these.
 *
 * No git surface in the adapters: the lib calls `git` directly via
 * `runGit(workingTreeRoot, args)` against a real on-disk working tree.
 */

export interface FsAdapter {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: Uint8Array): Promise<void>;
    exists(path: string): Promise<boolean>;
    symlink(target: string, linkPath: string): Promise<void>;
    remove(path: string): Promise<void>;
    glob(pattern: string): Promise<string[]>;
}

export type MasterFsResolution =
    | { kind: 'symlink'; target: string }
    | { kind: 'bytes'; bytes: Uint8Array; etag?: string }
    | { kind: 'not-found' };

export interface MasterFsAdapter {
    resolve(masterFsPath: string): Promise<MasterFsResolution>;
}

export type WorkdirLock = <T>(fn: () => Promise<T>) => Promise<T>;

export type WorkdirTier = 'managed' | 'remote-fs' | 'local-fs';

export interface Workdir {
    readonly workdirId: string;
    readonly tier: WorkdirTier;
    readonly workingTreeRoot: string;
    readonly branchRef: string;
    readonly fs: FsAdapter;
    readonly master: MasterFsAdapter;
    readonly lock: WorkdirLock;
}

export interface WorkdirInput {
    workdirId: string;
    tier: WorkdirTier;
    workingTreeRoot: string;
    fs: FsAdapter;
    master: MasterFsAdapter;
    lock: WorkdirLock;
}

export interface LayoutEntry {
    workspace: string;
    masterFsPath: string;
    treePath: string;
}

export interface BootInput extends WorkdirInput {
    visibleWorkspaces: ReadonlyArray<string>;
    layout: ReadonlyArray<LayoutEntry>;
}

export interface BootResult {
    workdir: Workdir;
    placed: ReadonlyArray<{ treePath: string; kind: 'symlink' | 'bytes' }>;
}
