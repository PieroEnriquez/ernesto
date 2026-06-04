import picomatch from 'picomatch';
import {
    FsAdapter, MasterFsAdapter,
    GlobOptions, GrepOptions, GrepResult, GrepOutputMode,
} from './types';

/** Same compile flags as `node-adapters.ts` so prod / tests don't diverge. */
function compileGlob(pattern: string): (p: string) => boolean {
    return picomatch(pattern, { dot: true });
}

function safeSubpath(sub: string | undefined): string {
    if (!sub) return '';
    if (sub.startsWith('/') || sub.includes('\\')) {
        throw new Error('invalid_path');
    }
    if (sub.split('/').some(seg => seg === '..')) {
        throw new Error('parent_segment_not_allowed');
    }
    return sub.replace(/^\.\/+/, '').replace(/\/+$/, '');
}

export function makeInMemoryFsAdapter(): FsAdapter {
    // Single flat map. Hard links on a real FS are two directory entries pointing
    // at the same inode; in-memory we model that as two map keys pointing at the
    // *same Uint8Array* reference (no copy). Reads from either key see the same
    // bytes; writes via `writeFile` replace the entry at one key only (matching
    // POSIX `open(O_TRUNC) + write` semantics — the other "link" still points at
    // the old bytes). For the test workloads here that's faithful enough.
    const files = new Map<string, Uint8Array>();
    // Insertion order doubles as "mtime newest-last" so `glob` can return
    // newest-first by reversing the map keys.
    const insertionOrder: string[] = [];
    function touch(p: string): void {
        const i = insertionOrder.indexOf(p);
        if (i !== -1) insertionOrder.splice(i, 1);
        insertionOrder.push(p);
    }

    return {
        async readFile(path) {
            const f = files.get(path);
            if (!f) throw new Error(`ENOENT: ${path}`);
            return f;
        },
        async writeFile(path, content) {
            files.set(path, content);
            touch(path);
        },
        async exists(path) {
            return files.has(path);
        },
        async link(sourcePath, linkPath) {
            const src = files.get(sourcePath);
            if (!src) throw new Error(`ENOENT: link source ${sourcePath}`);
            files.set(linkPath, src);
            touch(linkPath);
        },
        async remove(path) {
            files.delete(path);
            const i = insertionOrder.indexOf(path);
            if (i !== -1) insertionOrder.splice(i, 1);
        },
        async glob(pattern: string, options?: GlobOptions): Promise<string[]> {
            const sub = safeSubpath(options?.path);
            const isMatch = compileGlob(pattern);
            // Filter to keys under `sub` (if given) and matching the glob.
            const filtered = insertionOrder.filter(p => {
                if (sub && !(p === sub || p.startsWith(sub + '/'))) return false;
                return isMatch(p);
            });
            // Reverse insertion order ≈ newest-first.
            return filtered.reverse();
        },
        async grep(options: GrepOptions): Promise<GrepResult> {
            return runInMemoryGrep(files, options);
        },
    };
}

/**
 * JS-side ripgrep equivalent for the in-memory adapter. Supports the same
 * option surface as the node adapter's ripgrep wrapper — modulo the file-type
 * database (no `type: 'js'` heuristic) and multiline matches with absolute
 * line numbers (we report the line where the match *starts*).
 */
function runInMemoryGrep(
    files: Map<string, Uint8Array>,
    opts: GrepOptions,
): GrepResult {
    const mode: GrepOutputMode = opts.outputMode ?? 'files_with_matches';
    const flags = opts.caseInsensitive ? 'gi' : 'g';
    const reFlags = opts.multiline ? flags + 's' : flags;
    const re = new RegExp(opts.pattern, reFlags);

    const subRaw = safeSubpath(opts.path);
    // `path` may be a file or a directory; for a file we restrict to that key.
    // We can't tell them apart from the map alone, so treat exact match first.
    const pathFilter = (p: string): boolean => {
        if (!subRaw) return true;
        if (p === subRaw) return true;
        return p.startsWith(subRaw + '/');
    };

    // ripgrep's `--glob` matches the full path *or* the basename when the
    // pattern has no `/`. Mirror that so `--glob '*.tsx'` finds nested files.
    const globMatch = opts.glob
        ? (() => {
            const fullMatch = compileGlob(opts.glob);
            const baseMatch = opts.glob.includes('/') ? null : compileGlob(opts.glob);
            return (p: string): boolean => {
                if (fullMatch(p)) return true;
                if (baseMatch) {
                    const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p;
                    if (baseMatch(base)) return true;
                }
                return false;
            };
        })()
        : null;
    // No real "type database" — drop `type` filter silently in-memory (tests
    // that care exercise the node adapter).

    const dec = new TextDecoder();
    const contextBefore = mode === 'content' ? (opts.contextBefore ?? 0) : 0;
    const contextAfter = mode === 'content' ? (opts.contextAfter ?? 0) : 0;
    const showLineNumbers = mode === 'content' && opts.lineNumbers !== false;

    const out: string[] = [];

    // Iterate paths in deterministic order (sorted) so tests don't flake.
    const paths = [...files.keys()].filter(p => pathFilter(p)).sort();

    for (const p of paths) {
        if (globMatch && !globMatch(p)) continue;
        const text = dec.decode(files.get(p)!);

        if (opts.multiline) {
            // Reset lastIndex per file when in /g mode.
            re.lastIndex = 0;
            const matches: Array<{ index: number }> = [];
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
                matches.push({ index: m.index });
                if (m.index === re.lastIndex) re.lastIndex++;
            }
            if (matches.length === 0) continue;

            if (mode === 'files_with_matches') {
                out.push(p);
            } else if (mode === 'count') {
                out.push(`${p}:${matches.length}`);
            } else {
                // content mode: emit the line where each match starts.
                const lines = text.split('\n');
                const matchedLineIdxs = new Set<number>();
                for (const m of matches) {
                    let lineIdx = 0;
                    let acc = 0;
                    for (let i = 0; i < lines.length; i++) {
                        acc += lines[i].length + 1;
                        if (m.index < acc) { lineIdx = i; break; }
                    }
                    matchedLineIdxs.add(lineIdx);
                }
                emitContentLines(out, p, lines, matchedLineIdxs, showLineNumbers, contextBefore, contextAfter);
            }
        } else {
            const lines = text.split('\n');
            const matchedLineIdxs: number[] = [];
            for (let i = 0; i < lines.length; i++) {
                re.lastIndex = 0;
                if (re.test(lines[i])) matchedLineIdxs.push(i);
            }
            if (matchedLineIdxs.length === 0) continue;

            if (mode === 'files_with_matches') {
                out.push(p);
            } else if (mode === 'count') {
                out.push(`${p}:${matchedLineIdxs.length}`);
            } else {
                emitContentLines(out, p, lines, new Set(matchedLineIdxs), showLineNumbers, contextBefore, contextAfter);
            }
        }
    }

    const limit = opts.headLimit;
    let lines = out;
    let truncated = false;
    if (typeof limit === 'number' && limit >= 0 && out.length > limit) {
        lines = out.slice(0, limit);
        truncated = true;
    }
    return { lines, truncated, mode };
}

function emitContentLines(
    out: string[],
    p: string,
    lines: string[],
    matchedLineIdxs: ReadonlySet<number>,
    showLineNumbers: boolean,
    contextBefore: number,
    contextAfter: number,
): void {
    const emit = new Set<number>();
    for (const idx of matchedLineIdxs) {
        for (let d = -contextBefore; d <= contextAfter; d++) {
            const j = idx + d;
            if (j >= 0 && j < lines.length) emit.add(j);
        }
    }
    const sorted = [...emit].sort((a, b) => a - b);
    for (const idx of sorted) {
        if (showLineNumbers) {
            out.push(`${p}:${idx + 1}:${lines[idx]}`);
        } else {
            out.push(`${p}:${lines[idx]}`);
        }
    }
}

export interface InMemoryMasterFsOptions {
    /** path → bytes; populated entries resolve as `{ kind: 'bytes' }`. */
    bytes?: Map<string, Uint8Array>;
    /** When set, known paths resolve as `{ kind: 'hardlink'; sourcePath: `${hardlinkSourceRoot}/${path}` }`.
     *  Used to simulate the in-process / mcp transport volume case in unit tests — the in-memory
     *  FsAdapter's `link()` copies bytes from `sourcePath`, so the test fixture
     *  must `writeFile` the source bytes at `${hardlinkSourceRoot}/${path}` beforehand. */
    hardlinkSourceRoot?: string;
}

export function makeInMemoryMasterFs(opts: InMemoryMasterFsOptions): MasterFsAdapter {
    return {
        async resolve(masterFsPath) {
            if (opts.hardlinkSourceRoot !== undefined) {
                if (opts.bytes && !opts.bytes.has(masterFsPath)) {
                    return { kind: 'not-found' };
                }
                return {
                    kind: 'hardlink',
                    sourcePath: `${opts.hardlinkSourceRoot}/${masterFsPath}`,
                };
            }
            const bytes = opts.bytes?.get(masterFsPath);
            if (!bytes) return { kind: 'not-found' };
            return { kind: 'bytes', bytes };
        },
    };
}
