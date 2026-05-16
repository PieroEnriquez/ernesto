import { execFile } from 'child_process';
import { promisify } from 'util';

const pExecFile = promisify(execFile);

/**
 * Tiny git wrapper. Single helper, no class. Throws on non-zero exit with stderr.
 * No retry/transient-error handling at this layer — callers handle merge-conflict
 * and fast-forward shapes explicitly.
 *
 * `GIT_TERMINAL_PROMPT=0` is forced into the env so a missing credential never
 * blocks the calling process on stdin (the same trap that bit Tier-A early
 * and the Tier-C CLI before this consolidation).
 */
export async function runGit(cwd: string, args: ReadonlyArray<string>): Promise<string> {
    const { stdout } = await pExecFile('git', [...args], {
        cwd,
        maxBuffer: 100 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout;
}

/**
 * Non-throwing variant: returns a tagged result instead of rejecting. Same
 * wire as `runGit` so callers can swap between them based on whether they
 * want exceptions or branchable results. Stderr is preserved on the failure
 * branch.
 */
export async function tryRunGit(
    cwd: string,
    args: ReadonlyArray<string>,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    try {
        const stdout = await runGit(cwd, args);
        return { ok: true, stdout };
    } catch (err: any) {
        return { ok: false, error: String(err?.stderr ?? err?.message ?? err) };
    }
}
