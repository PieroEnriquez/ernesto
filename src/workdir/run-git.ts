import { execFile } from 'child_process';
import { promisify } from 'util';

const pExecFile = promisify(execFile);

/**
 * Tiny git wrapper. Single helper, no class. Throws on non-zero exit with stderr.
 * No retry/transient-error handling at this layer — callers handle merge-conflict
 * and fast-forward shapes explicitly.
 */
export async function runGit(cwd: string, args: ReadonlyArray<string>): Promise<string> {
    const { stdout } = await pExecFile('git', [...args], {
        cwd,
        maxBuffer: 100 * 1024 * 1024,
    });
    return stdout;
}
