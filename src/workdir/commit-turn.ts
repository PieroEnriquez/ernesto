import { Workdir } from './types';
import { runGit } from './run-git';

export interface CommitTurnInput {
    paths: ReadonlyArray<string>;
    message: string;
    files?: ReadonlyArray<{ path: string; content: Uint8Array }>;
}

export interface CommitTurnResult {
    sha: string;
}

/**
 * Take the workdir lock; write any provided files via the FS adapter; stage
 * the named paths; create a commit on the current branch. Releases the lock
 * via the `lock(fn)` contract regardless of success/failure.
 */
export async function commitTurn(workdir: Workdir, input: CommitTurnInput): Promise<CommitTurnResult> {
    return workdir.lock(async () => {
        if (input.files) {
            for (const f of input.files) {
                await workdir.fs.writeFile(f.path, f.content);
            }
        }
        await runGit(workdir.workingTreeRoot, ['add', '--', ...input.paths]);
        await runGit(workdir.workingTreeRoot, ['commit', '-m', input.message]);
        const sha = (await runGit(workdir.workingTreeRoot, ['rev-parse', 'HEAD'])).trim();
        return { sha };
    });
}
