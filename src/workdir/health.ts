import { promises as fsp } from 'fs';
import { join } from 'path';
import { runGit, tryRunGit } from './run-git';

/**
 * The three states a workdir directory can be in at open/setup time.
 *
 * - `missing`   — the directory doesn't exist, or has no `.git/`.
 * - `healthy`   — `.git/` is present *and* `git` accepts the directory.
 * - `corrupted` — `.git/` exists on disk but `git` rejects the directory
 *                 (e.g. `.git/HEAD` or `.git/config` are gone — observed
 *                 in the field on macOS dev where `/var/folders/.../T/`
 *                 and `/tmp/` are aperiodically pruned by the OS,
 *                 selectively deleting files untouched since clone).
 *
 * Both the in-process transport (backend's `openManagedWorkdir`) and the
 * laptop transport (`setupCmd`) hit this exact corruption and now share
 * this probe.
 */
export type WorkdirHealth = 'missing' | 'healthy' | 'corrupted';

/**
 * Cheap, reliable validity check. The same `rev-parse` git itself runs
 * before every other command — if it fails here, every subsequent
 * operation (fetch, status, commit) will also fail. Better to detect
 * once at open/setup time than chase a misleading "fatal: not a git
 * repository" mid-flow.
 */
export async function probeWorkdirHealth(workingTreeRoot: string): Promise<WorkdirHealth> {
    const dotGitExists = await fsp
        .stat(join(workingTreeRoot, '.git'))
        .then(() => true, () => false);
    if (!dotGitExists) return 'missing';
    const r = await tryRunGit(workingTreeRoot, ['rev-parse', '--show-toplevel']);
    return r.ok ? 'healthy' : 'corrupted';
}

export interface BootstrapWorkdirInput {
    /** Absolute path the working tree should live at after this call returns. */
    workingTreeRoot: string;
    /** Remote URL to clone from. Transport-specific (bot repo URL vs dev's GitHub PAT URL). */
    repoUrl: string;
    /** Branch to clone (typically `'main'`). */
    branch: string;
    /**
     * git config keys to apply post-clone, e.g.
     * `{ 'user.email': 'ernesto-bot@example.com', 'commit.gpgsign': 'false' }`.
     * Defaults to none — caller decides identity.
     */
    gitConfig?: Record<string, string>;
    /**
     * When set, passed to `git clone` as `--depth=<n>`. A depth of 1 makes
     * the clone shallow — no history, just the tip of `branch` — which is
     * dramatically faster for throwaway workdirs (e.g. subagent
     * runs) that never need to walk history. Persistent session workdirs
     * leave this unset; they may later want `git log`, `git blame`, or
     * to settle a rebase that requires fetching common ancestors.
     */
    depth?: number;
}

/**
 * Wipe + clone + apply post-clone git config. The shared bootstrap shape
 * used by both the in-process transport's `openManagedWorkdir` (when its
 * `isWorkdirHealthy` probe fails) and the laptop transport's `setupCmd --force`.
 *
 * The *recovery policy* (silent self-heal vs fail-loud) stays in the
 * caller — the in-process transport wipes silently because its workdir is
 * an ephemeral lint-substrate with no user state to preserve; the laptop
 * transport fails loud without `--force` because the laptop's working tree can hold
 * uncommitted dev edits. The mechanics (wipe-recreate-clone-config)
 * are identical and live here.
 */
export async function bootstrapWorkdir(input: BootstrapWorkdirInput): Promise<void> {
    const { workingTreeRoot, repoUrl, branch, gitConfig, depth } = input;
    await fsp.rm(workingTreeRoot, { recursive: true, force: true });
    await fsp.mkdir(workingTreeRoot, { recursive: true });
    const cloneArgs = ['clone', '--branch', branch, '--single-branch'];
    if (depth !== undefined) cloneArgs.push(`--depth=${depth}`);
    cloneArgs.push(repoUrl, '.');
    await runGit(workingTreeRoot, cloneArgs);
    for (const [k, v] of Object.entries(gitConfig ?? {})) {
        await runGit(workingTreeRoot, ['config', k, v]);
    }
}
