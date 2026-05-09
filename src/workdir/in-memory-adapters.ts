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
    const files = new Map<string, Uint8Array>();
    const symlinks = new Map<string, string>();

    return {
        async readFile(path) {
            const target = symlinks.get(path);
            if (target !== undefined) {
                const f = files.get(target);
                if (!f) throw new Error(`ENOENT: ${path} → ${target}`);
                return f;
            }
            const f = files.get(path);
            if (!f) throw new Error(`ENOENT: ${path}`);
            return f;
        },
        async writeFile(path, content) {
            symlinks.delete(path);
            files.set(path, content);
        },
        async exists(path) {
            return files.has(path) || symlinks.has(path);
        },
        async symlink(target, linkPath) {
            files.delete(linkPath);
            symlinks.set(linkPath, target);
        },
        async remove(path) {
            files.delete(path);
            symlinks.delete(path);
        },
        async glob(pattern) {
            const all = [...files.keys(), ...symlinks.keys()];
            return all.filter(p => matchesGlob(p, pattern));
        },
    };
}

export interface InMemoryMasterFsOptions {
    /** path → bytes; populated entries resolve as `{ kind: 'bytes' }`. */
    bytes?: Map<string, Uint8Array>;
    /** if set, all known paths resolve as `{ kind: 'symlink'; target: `${symlinkRoot}/${path}` }`.
     *  Used to simulate the volume case in unit tests without a real FS. */
    symlinkRoot?: string;
}

export function makeInMemoryMasterFs(opts: InMemoryMasterFsOptions): MasterFsAdapter {
    return {
        async resolve(masterFsPath) {
            if (opts.symlinkRoot !== undefined) {
                if (opts.bytes && !opts.bytes.has(masterFsPath)) {
                    return { kind: 'not-found' };
                }
                return { kind: 'symlink', target: `${opts.symlinkRoot}/${masterFsPath}` };
            }
            const bytes = opts.bytes?.get(masterFsPath);
            if (!bytes) return { kind: 'not-found' };
            return { kind: 'bytes', bytes };
        },
    };
}
