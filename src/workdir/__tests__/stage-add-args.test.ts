import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { runGit, tryRunGit } from '../run-git';
import { buildStageAddArgs } from '../settle-core';

/**
 * Regression: when generated content is `.gitignore`d in the workspaces repo
 * (the master-fs untrack), `git add -- <ws> :(exclude)<ignored-path>` FAILS
 * with "the following paths are ignored … use -f" for any ignored path that
 * exists on disk — even though it is only being excluded. That broke every
 * settle / open-workdir staging fleet-wide. `buildStageAddArgs` must drop the
 * exclude for gitignored generated paths (git skips them in the dir-walk
 * anyway) while keeping it for tracked / not-ignored ones.
 */
describe('buildStageAddArgs — gitignored generated paths', () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'ernesto-stageargs-'));
        await runGit(root, ['init', '-q']);
        await runGit(root, ['config', 'user.email', 't@t']);
        await runGit(root, ['config', 'user.name', 't']);
        const ws = path.join(root, 'workspaces', 'hr');
        await mkdir(path.join(ws, 'extracted'), { recursive: true });
        await writeFile(path.join(ws, 'WORKSPACE.md'), '---\nname: hr\n---\n');
        // generated content that the untrack gitignores
        await writeFile(path.join(ws, 'extracted', 'a.md'), 'gen\n');
        await writeFile(path.join(ws, '.derived-from-sha'), 'deadbeef\n');
        // generated content NOT gitignored (still pathspec-excluded)
        await writeFile(path.join(ws, 'attachments.yaml'), 'k: v\n');
        // the .gitignore the master-fs untrack introduced
        await writeFile(
            path.join(root, '.gitignore'),
            '**/extracted/\n**/_results/\n.derived-from-sha\n',
        );
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('drops :(exclude) for gitignored generated paths, keeps it for non-ignored', async () => {
        const args = await buildStageAddArgs(root, ['workspaces/hr']);
        expect(args).not.toBeNull();
        const a = args!.join(' ');
        // gitignored + on disk → exclude dropped (naming it would error)
        expect(a).not.toContain(':(exclude)workspaces/hr/extracted');
        expect(a).not.toContain(':(exclude)workspaces/hr/.derived-from-sha');
        // not gitignored → exclude kept (still must stay out of the index)
        expect(a).toContain(':(exclude)workspaces/hr/attachments.yaml');
        // the workspace itself is always staged
        expect(args![0]).toBe('add');
        expect(a).toContain('workspaces/hr');
    });

    it('git add with the produced args succeeds and stages no generated content', async () => {
        const args = await buildStageAddArgs(root, ['workspaces/hr']);
        // THE regression: this used to throw "paths are ignored, use -f".
        const res = await tryRunGit(root, args!);
        expect(res.ok).toBe(true);

        const staged = (await runGit(root, ['diff', '--cached', '--name-only'])).trim().split('\n');
        expect(staged).toContain('workspaces/hr/WORKSPACE.md');
        // none of the generated paths leaked into the index
        expect(staged).not.toContain('workspaces/hr/extracted/a.md');
        expect(staged).not.toContain('workspaces/hr/.derived-from-sha');
        expect(staged).not.toContain('workspaces/hr/attachments.yaml');
    });

    it('keeps the exclude (and does not error) when a generated dir is absent', async () => {
        // _results/ is gitignored-by-pattern but absent on disk → check-ignore
        // does not match a non-existent dir-only pattern, so the exclude stays;
        // a non-existent excluded path never triggers the ignored-paths error.
        const args = await buildStageAddArgs(root, ['workspaces/hr']);
        expect(args!.join(' ')).toContain(':(exclude)workspaces/hr/_results');
        const res = await tryRunGit(root, args!);
        expect(res.ok).toBe(true);
    });
});
