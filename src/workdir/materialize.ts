import { Workdir } from './types';

/**
 * Ensure a master-FS-backed file is present in the working tree.
 *
 * If the path is already in the working tree, no-op. Otherwise resolve via
 * the master FS adapter and place the result:
 *   - `hardlink` → `fs.link()` the master-fs file into the working tree
 *   - `bytes`    → write bytes to the working tree
 *   - `not-found` → return `{ kind: 'not-found' }` and do nothing
 *
 * Used by Tier C's PreToolUse `Read` hook (lazy fetch over HTTPS) and by
 * `bootWorkdir`'s eager-set placement path.
 */
export type MaterializeResult =
    | { kind: 'placed'; placement: 'hardlink' | 'bytes' }
    | { kind: 'already-present' }
    | { kind: 'not-found' };

export async function materializeFile(
    workdir: Workdir,
    args: { treePath: string; masterFsPath: string },
): Promise<MaterializeResult> {
    if (await workdir.fs.exists(args.treePath)) {
        return { kind: 'already-present' };
    }
    const r = await workdir.master.resolve(args.masterFsPath);
    if (r.kind === 'not-found') return { kind: 'not-found' };
    if (r.kind === 'hardlink') {
        await workdir.fs.link(r.sourcePath, args.treePath);
        return { kind: 'placed', placement: 'hardlink' };
    }
    await workdir.fs.writeFile(args.treePath, r.bytes);
    return { kind: 'placed', placement: 'bytes' };
}
