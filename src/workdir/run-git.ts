import { execFile } from 'child_process';
import { promisify } from 'util';

const pExecFile = promisify(execFile);

/**
 * Per-invocation overrides for {@link runGit}/{@link tryRunGit}.
 *   - `env`   — extra environment variables, layered ON TOP of the forced
 *               `GIT_TERMINAL_PROMPT`/`GIT_CEILING_DIRECTORIES` defaults (e.g.
 *               `GIT_INDEX_FILE` to drive a temporary index without touching
 *               the workdir's real one — see `settle-from-overlay.ts`).
 *   - `stdin` — content piped to git's stdin (e.g. `hash-object --stdin`).
 */
export interface RunGitOptions {
    env?: Readonly<Record<string, string>>;
    stdin?: string;
}

/**
 * Tiny git wrapper. Single helper, no class. Throws on non-zero exit with stderr.
 * No retry/transient-error handling at this layer — callers handle merge-conflict
 * and fast-forward shapes explicitly.
 *
 * `GIT_TERMINAL_PROMPT=0` is forced into the env so a missing credential never
 * blocks the calling process on stdin (the same trap that bit the in-process
 * transport early and the laptop CLI before this consolidation).
 *
 * `GIT_CEILING_DIRECTORIES=cwd` stops git's auto-discovery from walking above
 * the given `cwd` to find a `.git/` in a parent. Without this, ops run from a
 * non-repo subdir (e.g. a materialized checkout nested inside a workdir) can
 * silently retarget the parent workdir's `.git`, corrupting it. With the
 * ceiling, such ops fail loudly with "not a git repository" instead.
 *
 * `opts.env` is layered after the forced defaults so a caller can add vars
 * (e.g. `GIT_INDEX_FILE`) without losing the safety env. `opts.stdin`, when
 * given, is piped to the child's stdin.
 */
export async function runGit(cwd: string, args: ReadonlyArray<string>, opts?: RunGitOptions): Promise<string> {
    const child = pExecFile('git', [...args], {
        cwd,
        maxBuffer: 100 * 1024 * 1024,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_CEILING_DIRECTORIES: cwd,
            ...opts?.env,
        },
    });
    if (opts?.stdin !== undefined) {
        child.child.stdin?.end(opts.stdin);
    }
    const { stdout } = await child;
    return stdout;
}

/**
 * Non-throwing variant: returns a tagged result instead of rejecting. Same
 * wire as `runGit` so callers can swap between them based on whether they
 * want exceptions or branchable results. `stdout` is preserved on BOTH
 * branches (some git commands — e.g. `merge-tree` on conflict — exit non-zero
 * yet write the meaningful payload to stdout); `error` carries stderr.
 */
export async function tryRunGit(
    cwd: string,
    args: ReadonlyArray<string>,
    opts?: RunGitOptions,
): Promise<{ ok: true; stdout: string } | { ok: false; error: string; stdout: string }> {
    try {
        const stdout = await runGit(cwd, args, opts);
        return { ok: true, stdout };
    } catch (err: any) {
        return {
            ok: false,
            error: String(err?.stderr ?? err?.message ?? err),
            stdout: typeof err?.stdout === 'string' ? err.stdout : '',
        };
    }
}
