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

/**
 * Re-mirror an already-placed file. Unlike `materializeFile`, this replaces
 * the entry at `treePath` regardless of whether it's present.
 *
 * Why this exists: master-fs writes (extraction/derive workers) use atomic
 * temp+rename, which produces a *new* inode. Hard links placed at session
 * boot still point at the *old* inode and silently serve stale bytes. The
 * live-update path publishes the changed paths over pubsub; the subscriber
 * calls `remirrorFile` for each active workdir whose scope includes the
 * touched workspace, so the workdir's directory entry is re-pointed at the
 * fresh inode (hardlink tier) or rewritten (bytes tier).
 *
 * Returns `not-found` when the master-fs resolver doesn't know about the
 * path — caller should treat that as "removed from master-fs" and may want
 * to remove the workdir entry; this function does NOT remove, since that's
 * a policy call (a transient resolver miss shouldn't blow up the workdir).
 */
export async function remirrorFile(
    workdir: Workdir,
    args: { treePath: string; masterFsPath: string },
): Promise<MaterializeResult> {
    const r = await workdir.master.resolve(args.masterFsPath);
    if (r.kind === 'not-found') return { kind: 'not-found' };
    if (r.kind === 'hardlink') {
        // `fs.link` adapters (both node and in-memory) unlink the destination
        // first when present, so re-mirroring is a single call.
        await workdir.fs.link(r.sourcePath, args.treePath);
        return { kind: 'placed', placement: 'hardlink' };
    }
    await workdir.fs.writeFile(args.treePath, r.bytes);
    return { kind: 'placed', placement: 'bytes' };
}
