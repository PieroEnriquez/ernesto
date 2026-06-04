import { promises as fsp } from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import {
    FsAdapter, MasterFsAdapter,
    GlobOptions, GrepOptions, GrepResult, GrepOutputMode,
} from './types';
import { compileGlob, safeSubpath } from './glob-util';

/** Backend & CLI default. Wraps node `fs`, rooted at `workingTreeRoot`. */
export function makeNodeFsAdapter(workingTreeRoot: string): FsAdapter {
    const abs = (p: string) => path.resolve(workingTreeRoot, p);

    return {
        async readFile(p) {
            return new Uint8Array(await fsp.readFile(abs(p)));
        },
        async writeFile(p, content) {
            const a = abs(p);
            await fsp.mkdir(path.dirname(a), { recursive: true });
            await fsp.writeFile(a, content);
        },
        async exists(p) {
            try {
                await fsp.lstat(abs(p));
                return true;
            } catch {
                return false;
            }
        },
        async link(sourcePath, linkPath) {
            // `sourcePath` is an absolute host-FS path (e.g. into master-fs);
            // `linkPath` is workdir-relative. Pre-empt any prior entry at the
            // destination so re-mirroring on host boot is idempotent.
            const a = abs(linkPath);
            await fsp.mkdir(path.dirname(a), { recursive: true });
            try {
                await fsp.unlink(a);
            } catch { /* not present */ }
            await fsp.link(sourcePath, a);
        },
        async remove(p) {
            await fsp.rm(abs(p), { recursive: true, force: true });
        },
        async glob(pattern: string, options?: GlobOptions): Promise<string[]> {
            const sub = safeSubpath(options?.path);
            const isMatch = compileGlob(pattern);
            // Walk the tree (real FS), collect rel-path + mtime, filter, sort.
            const collected: Array<{ relPath: string; mtimeMs: number }> = [];
            const startRel = sub;
            async function walk(rel: string): Promise<void> {
                let entries;
                try {
                    entries = await fsp.readdir(abs(rel || '.'), { withFileTypes: true });
                } catch {
                    return;
                }
                for (const e of entries) {
                    // Skip `.git` — never glob into the worktree's git metadata.
                    if (e.name === '.git' && !rel) continue;
                    const child = rel ? `${rel}/${e.name}` : e.name;
                    if (e.isDirectory()) {
                        await walk(child);
                    } else if (e.isFile()) {
                        // Match against the path *relative to the workdir root*,
                        // so patterns like `workspaces/**/*.md` work regardless
                        // of `options.path`.
                        if (isMatch(child)) {
                            try {
                                const st = await fsp.stat(abs(child));
                                collected.push({ relPath: child, mtimeMs: st.mtimeMs });
                            } catch {
                                /* race: file disappeared, skip */
                            }
                        }
                    }
                }
            }
            await walk(startRel);
            // Newest-first to match Claude Code's native Glob behavior.
            collected.sort((a, b) => b.mtimeMs - a.mtimeMs);
            return collected.map(c => c.relPath);
        },
        async grep(options: GrepOptions): Promise<GrepResult> {
            return runRipgrep(workingTreeRoot, options);
        },
    };
}

/**
 * Backend volume-side master FS. Returns the host-FS source path; the caller
 * (`bootWorkdir`) hard-links it into the working tree via
 * `fs.link()`. Directory symlinks were v1 — ripgrep skipped them during
 * traversal, making fs_glob/fs_grep blind to the master-fs subtree. Hard
 * links are real directory entries pointing at the same inode, so the agent's
 * discovery tools walk them normally. Requires the working tree and master-fs
 * to be on the same volume (same device for `link(2)`).
 */
export function makeVolumeMasterFs(masterFsRoot: string): MasterFsAdapter {
    return {
        async resolve(masterFsPath) {
            const sourcePath = path.join(masterFsRoot, masterFsPath);
            try {
                await fsp.access(sourcePath);
                return { kind: 'hardlink', sourcePath };
            } catch {
                return { kind: 'not-found' };
            }
        },
    };
}

// ─── ripgrep front-end ────────────────────────────────────────────────────

export class RipgrepNotInstalledError extends Error {
    constructor() {
        super('ripgrep_not_installed');
        this.name = 'RipgrepNotInstalledError';
    }
}

/**
 * Run ripgrep over `workingTreeRoot`. We shell out to the `rg` binary because
 * (a) it's an order of magnitude faster than any JS implementation and
 * (b) its CLI is the exact surface Claude Code's native Grep advertises, so
 * agents writing Grep-style queries get parity.
 *
 * The binary MUST be on PATH at runtime. We fail loudly with
 * `ripgrep_not_installed` if it isn't.
 */
async function runRipgrep(workingTreeRoot: string, opts: GrepOptions): Promise<GrepResult> {
    const mode: GrepOutputMode = opts.outputMode ?? 'files_with_matches';
    const args: string[] = [];

    // Sane defaults: no color, never recurse submodules, follow no symlinks.
    args.push('--no-config', '--no-ignore-vcs');
    // ripgrep respects .gitignore by default; in the workdir we want that
    // (settle filters `_tmp` etc by gitignore too). Keep default behavior.

    if (opts.caseInsensitive) args.push('-i');

    if (opts.multiline) {
        // `-U` enables multi-line matches; combine with --multiline-dotall so
        // `.` spans `\n` — what native Grep `multiline: true` documents.
        args.push('-U', '--multiline-dotall');
    }

    if (opts.glob) {
        args.push('--glob', opts.glob);
    }
    if (opts.type) {
        args.push('--type', opts.type);
    }

    switch (mode) {
        case 'files_with_matches':
            args.push('-l');
            break;
        case 'count':
            args.push('-c');
            break;
        case 'content':
            // Line numbers default to true.
            if (opts.lineNumbers !== false) args.push('-n');
            if (opts.contextBefore && opts.contextBefore > 0) args.push('-B', String(opts.contextBefore));
            if (opts.contextAfter && opts.contextAfter > 0) args.push('-A', String(opts.contextAfter));
            // `--no-heading` keeps `path:line:text` on every row (parser-friendly).
            args.push('--no-heading');
            break;
    }

    // End-of-flags + pattern.
    args.push('-e', opts.pattern);

    // Path restriction. Lexically validated; passed as a positional arg.
    if (opts.path) {
        const sub = safeSubpath(opts.path);
        if (sub) args.push(sub);
    }

    // Use `spawn` rather than `execFile` because some macOS dev hosts hang
    // when `execFile`'s default piping interacts with ripgrep's multi-threaded
    // worker output (multi-MB buffers + multi-thread writers). With explicit
    // listeners we drain both streams as they fill. Doesn't change prod.
    let stdout = '';
    try {
        stdout = await new Promise<string>((resolve, reject) => {
            const child = spawn('rg', args, {
                cwd: workingTreeRoot,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let out = '';
            let err = '';
            let outBytes = 0;
            const MAX_BYTES = 16 * 1024 * 1024;
            child.stdout.on('data', (d: Buffer) => {
                outBytes += d.length;
                if (outBytes > MAX_BYTES) {
                    child.kill('SIGTERM');
                    reject(new Error('ripgrep_output_exceeded_max_buffer'));
                    return;
                }
                out += d.toString('utf8');
            });
            child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
            child.on('error', (e: NodeJS.ErrnoException) => {
                if (e.code === 'ENOENT') reject(new RipgrepNotInstalledError());
                else reject(e);
            });
            child.on('close', (code: number | null) => {
                if (code === 0) resolve(out);
                else if (code === 1) resolve(''); // no matches
                else reject(new Error(`ripgrep_failed: ${err.slice(0, 200)}`));
            });
        });
    } catch (err: unknown) {
        if (err instanceof RipgrepNotInstalledError) throw err;
        throw err;
    }

    const rawLines = stdout.split('\n');
    // Drop the trailing empty line ripgrep emits.
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();

    const limit = opts.headLimit;
    let lines: string[] = rawLines;
    let truncated = false;
    if (typeof limit === 'number' && limit >= 0 && rawLines.length > limit) {
        lines = rawLines.slice(0, limit);
        truncated = true;
    }
    return { lines, truncated, mode };
}
