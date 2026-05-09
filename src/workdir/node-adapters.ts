import { promises as fsp } from 'fs';
import * as path from 'path';
import { FsAdapter, MasterFsAdapter } from './types';

function matchesGlob(p: string, pattern: string): boolean {
    if (pattern === p) return true;
    if (pattern.endsWith('/**')) {
        const prefix = pattern.slice(0, -3);
        return p === prefix || p.startsWith(prefix + '/');
    }
    if (pattern.endsWith('/*')) {
        const prefix = pattern.slice(0, -2);
        if (!p.startsWith(prefix + '/')) return false;
        return !p.slice(prefix.length + 1).includes('/');
    }
    return false;
}

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
        async symlink(target, linkPath) {
            const a = abs(linkPath);
            await fsp.mkdir(path.dirname(a), { recursive: true });
            try {
                await fsp.unlink(a);
            } catch { /* not present */ }
            await fsp.symlink(target, a);
        },
        async remove(p) {
            await fsp.rm(abs(p), { recursive: true, force: true });
        },
        async glob(pattern) {
            const out: string[] = [];
            async function walk(rel: string): Promise<void> {
                let entries;
                try {
                    entries = await fsp.readdir(abs(rel || '.'), { withFileTypes: true });
                } catch {
                    return;
                }
                for (const e of entries) {
                    const child = rel ? `${rel}/${e.name}` : e.name;
                    if (e.isDirectory()) await walk(child);
                    else out.push(child);
                }
            }
            await walk('');
            return out.filter(p => matchesGlob(p, pattern));
        },
    };
}

/** Backend volume-side master FS. Resolves to a symlink target on the host FS. */
export function makeVolumeMasterFs(masterFsRoot: string): MasterFsAdapter {
    return {
        async resolve(masterFsPath) {
            const target = path.join(masterFsRoot, masterFsPath);
            try {
                await fsp.access(target);
                return { kind: 'symlink', target };
            } catch {
                return { kind: 'not-found' };
            }
        },
    };
}
