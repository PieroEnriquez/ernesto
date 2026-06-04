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

/**
 * Glob input. `pattern` is a workdir-relative bash-style glob compiled by
 * picomatch (supports `*`, `**`, `?`, character classes `[a-z]`, brace
 * expansion `{ts,tsx}`, and leading-`!` negation — exactly the subset
 * Claude Code's native Glob tool exposes). `path` optionally restricts the
 * search to a workdir-relative subtree.
 *
 * Returns workdir-relative paths sorted by modification time (newest first)
 * to match Claude Code's native Glob.
 */
export interface GlobOptions {
    path?: string;
}

/**
 * Grep input modeled on Claude Code's native Grep (a ripgrep front-end).
 *
 * - `pattern`     — regex (extended by default; PCRE-style classes work on rg).
 * - `path`        — workdir-relative file or directory to search (defaults to root).
 * - `glob`        — picomatch-shaped glob filter, e.g. `*.ts` or `**\/*.{ts,tsx}`.
 * - `type`        — ripgrep file-type, e.g. `js`, `py`, `rust`.
 * - `caseInsensitive` — maps to `-i`.
 * - `contextBefore` / `contextAfter` — line context; only honored when `outputMode: 'content'`.
 * - `lineNumbers` — line numbers in content output (default true).
 * - `multiline`   — patterns may span lines (rg `-U --multiline-dotall`).
 * - `outputMode`  — `content` | `files_with_matches` | `count` (default `files_with_matches`).
 * - `headLimit`   — cap number of output rows.
 */
export type GrepOutputMode = 'content' | 'files_with_matches' | 'count';

export interface GrepOptions {
    pattern: string;
    path?: string;
    glob?: string;
    type?: string;
    caseInsensitive?: boolean;
    contextBefore?: number;
    contextAfter?: number;
    lineNumbers?: boolean;
    multiline?: boolean;
    outputMode?: GrepOutputMode;
    headLimit?: number;
}

export interface GrepResult {
    /** Raw output lines (one per match / file / counted entry). */
    lines: ReadonlyArray<string>;
    /** True if output was truncated by `headLimit`. */
    truncated: boolean;
    /** Output mode actually used (echoed for clarity). */
    mode: GrepOutputMode;
}

export interface FsAdapter {
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, content: Uint8Array): Promise<void>;
    exists(path: string): Promise<boolean>;
    /** Create a hard link at `linkPath` pointing at the same inode as `sourcePath`.
     *  Used by `bootWorkdir` to surface master-fs content into the
     *  working tree on the in-process and mcp transports. Symlinks were the v1 placement, but ripgrep (engine
     *  behind fs_glob/fs_grep) skips symlinks during traversal — hard links walk
     *  normally. The in-memory adapter implements this as a byte copy. */
    link(sourcePath: string, linkPath: string): Promise<void>;
    remove(path: string): Promise<void>;
    /** Glob, workdir-rooted. See `GlobOptions`. */
    glob(pattern: string, options?: GlobOptions): Promise<string[]>;
    /** Grep, workdir-rooted. See `GrepOptions`. */
    grep(options: GrepOptions): Promise<GrepResult>;
}

export type MasterFsResolution =
    | { kind: 'hardlink'; sourcePath: string }
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
    placed: ReadonlyArray<{ treePath: string; kind: 'hardlink' | 'bytes' }>;
}
