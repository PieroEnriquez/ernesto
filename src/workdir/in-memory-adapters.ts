import { FsAdapter, MasterFsAdapter } from './types';

function matchesGlob(path: string, pattern: string): boolean {
    if (pattern === path) return true;
    if (pattern.endsWith('/**')) {
        const prefix = pattern.slice(0, -3);
        return path === prefix || path.startsWith(prefix + '/');
    }
    if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -2);
        if (!path.startsWith(prefix + '/')) return false;
        const rest = path.slice(prefix.length + 1);
        return !rest.includes('/');
    }
    return false;
}

export function makeInMemoryFsAdapter(): FsAdapter {
    // Single flat map. Hard links on a real FS are two directory entries pointing
    // at the same inode; in-memory we model that as two map keys pointing at the
    // *same Uint8Array* reference (no copy). Reads from either key see the same
    // bytes; writes via `writeFile` replace the entry at one key only (matching
    // POSIX `open(O_TRUNC) + write` semantics — the other "link" still points at
    // the old bytes). For the test workloads here that's faithful enough.
    const files = new Map<string, Uint8Array>();

    return {
        async readFile(path) {
            const f = files.get(path);
            if (!f) throw new Error(`ENOENT: ${path}`);
            return f;
        },
        async writeFile(path, content) {
            files.set(path, content);
        },
        async exists(path) {
            return files.has(path);
        },
        async link(sourcePath, linkPath) {
            const src = files.get(sourcePath);
            if (!src) throw new Error(`ENOENT: link source ${sourcePath}`);
            files.set(linkPath, src);
        },
        async remove(path) {
            files.delete(path);
        },
        async glob(pattern) {
            return [...files.keys()].filter(p => matchesGlob(p, pattern));
        },
    };
}

export interface InMemoryMasterFsOptions {
    /** path → bytes; populated entries resolve as `{ kind: 'bytes' }`. */
    bytes?: Map<string, Uint8Array>;
    /** When set, known paths resolve as `{ kind: 'hardlink'; sourcePath: `${hardlinkSourceRoot}/${path}` }`.
     *  Used to simulate the Tier A/B volume case in unit tests — the in-memory
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
