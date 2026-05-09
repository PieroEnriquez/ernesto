import { BootInput, BootResult, Workdir, WorkdirInput } from './types';

/**
 * Lay out the working tree from master FS for the visible workspaces.
 *
 * For each layout entry whose `workspace` is in `visibleWorkspaces`:
 *   - resolve via master FS adapter
 *   - if `symlink` → create symlink in working tree
 *   - if `bytes`   → write bytes to working tree
 *   - if `not-found` → skip (caller responsibility to declare it)
 *
 * Pure on adapters: no global state, no environment reads. The same input
 * produces byte-identical output across the in-memory and node adapter pairs.
 */
export async function bootWorkdir(input: BootInput): Promise<BootResult> {
    const { fs, master, layout, visibleWorkspaces } = input;
    const visible = new Set(visibleWorkspaces);
    const placed: Array<{ treePath: string; kind: 'symlink' | 'bytes' }> = [];

    for (const entry of layout) {
        if (!visible.has(entry.workspace)) continue;
        const r = await master.resolve(entry.masterFsPath);
        if (r.kind === 'not-found') continue;
        if (r.kind === 'symlink') {
            await fs.symlink(r.target, entry.treePath);
            placed.push({ treePath: entry.treePath, kind: 'symlink' });
        } else {
            await fs.writeFile(entry.treePath, r.bytes);
            placed.push({ treePath: entry.treePath, kind: 'bytes' });
        }
    }

    return { workdir: rehydrateWorkdir(input), placed };
}

/** Pure: bundles inputs into a Workdir value. No I/O. */
export function rehydrateWorkdir(input: WorkdirInput): Workdir {
    return {
        workdirId: input.workdirId,
        tier: input.tier,
        workingTreeRoot: input.workingTreeRoot,
        branchRef: `refs/workdirs/${input.workdirId}`,
        fs: input.fs,
        master: input.master,
        lock: input.lock,
    };
}
