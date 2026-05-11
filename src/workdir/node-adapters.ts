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
        async link(sourcePath, linkPath) {
            // `sourcePath` is an absolute host-FS path (e.g. into master-fs);
            // `linkPath` is workdir-relative. Pre-empt any prior entry at the
            // destination so re-mirroring on session boot is idempotent.
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

/**
 * Backend volume-side master FS. Returns the host-FS source path; the caller
 * (`bootWorkdir`/`materializeFile`) hard-links it into the working tree via
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
