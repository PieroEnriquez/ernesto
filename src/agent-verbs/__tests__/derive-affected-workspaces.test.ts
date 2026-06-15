import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile } from 'fs/promises';
import * as path from 'path';
import { runGit } from '../../workdir/run-git';
import type { LintFn, PushToMainFn } from '../../workdir';
import { handleSettle } from '../settle';
import type { SettleVerbContext } from '../settle';
import { buildWorkdir as kitBuildWorkdir } from '../../__tests__/kit';

const allowAllLint: LintFn = async () => ({ ok: true });
const okPush: PushToMainFn = async ({ sha }) => ({ ok: true, sha });

function makeLog() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/**
 * Pins workspace derivation FROM THE SELECTED `files` (the by-reference settle
 * contract) — exercised through `handleSettle`, whose `onSettleSuccess` hook
 * receives the derived set: nesting-aware boundary resolution
 * (`deriveWorkspacesFromFiles` → `boundaryForPath`), with generated content
 * skipped by path segment and a draftable `attachments.yaml` resolving normally.
 *
 * (Whole-working-tree `deriveAffectedWorkspaces` is gone — settle no longer
 * publishes the whole draft implicitly; it derives the access boundary from the
 * agent's explicit selection.)
 */
describe('handleSettle — workspace derivation from selection (nesting + attachments.yaml)', () => {
    let tmpRoot: string;
    let built: Awaited<ReturnType<typeof kitBuildWorkdir>>;

    beforeEach(async () => {
        built = await kitBuildWorkdir({ prefix: 'ernesto-derive-ws-', workdirId: 'wd1' });
        tmpRoot = built.root;
        // Committed boundaries: flat `hr` plus the nested `hr/recruiting` leaf.
        await mkdir(path.join(tmpRoot, 'workspaces', 'hr', 'recruiting'), { recursive: true });
        await writeFile(path.join(tmpRoot, 'workspaces', 'hr', 'WORKSPACE.md'), '---\nname: hr\n---\n');
        await writeFile(path.join(tmpRoot, 'workspaces', 'hr', 'recruiting', 'WORKSPACE.md'), '---\nname: recruiting\n---\n');
        await runGit(tmpRoot, ['add', '-A']);
        await runGit(tmpRoot, ['commit', '-q', '-m', 'seed boundaries']);
    });

    afterEach(async () => {
        await built.cleanup();
    });

    function makeCtx(overrides: Partial<SettleVerbContext> = {}): SettleVerbContext {
        return {
            user: { id: 'u1' },
            scopes: new Set(['test:write']),
            lint: allowAllLint,
            pushToMain: okPush,
            log: makeLog(),
            ...overrides,
        };
    }

    it('a selected yaml-only change derives its workspace', async () => {
        // attachments.yaml is a tracked, draftable file — selecting a pending
        // yaml edit alone derives its owning workspace (no longer skipped).
        await writeFile(path.join(tmpRoot, 'workspaces', 'hr', 'attachments.yaml'), '- name: playbook.pdf\n  sha256: aa11\n');

        const onSuccess = vi.fn(async () => {});
        const r = await handleSettle(
            built.workdir,
            { message: 'attach playbook', files: ['workspaces/hr/attachments.yaml'] },
            makeCtx({ hooks: { onSettleSuccess: onSuccess } }),
        );

        expect(r.ok).toBe(true);
        expect(onSuccess.mock.calls[0][0]).toEqual(['hr']);
    });

    it('a selection of only generated content under a NESTED workspace derives nothing → selection_required', async () => {
        await mkdir(path.join(tmpRoot, 'workspaces', 'hr', 'recruiting', 'extracted'), { recursive: true });
        await writeFile(path.join(tmpRoot, 'workspaces', 'hr', 'recruiting', 'extracted', 'x.md'), 'mirror bytes\n');

        const onSuccess = vi.fn(async () => {});
        const onFailure = vi.fn(async () => {});
        const r = await handleSettle(
            built.workdir,
            { message: 'noop', files: ['workspaces/hr/recruiting/extracted/x.md'] },
            makeCtx({ hooks: { onSettleSuccess: onSuccess, onSettleFailure: onFailure } }),
        );

        expect(r.ok).toBe(false);
        if (r.ok) return;
        // Generated content is never author intent: the selection matched no
        // workspace path, so settle refuses (never marks the parent or the leaf).
        expect(r.error).toBe('selection_required');
        expect(onSuccess).not.toHaveBeenCalled();
        expect(onFailure).not.toHaveBeenCalled();
    });

    it('a selected nested prose edit derives the SUB-workspace leaf, not the parent', async () => {
        await writeFile(path.join(tmpRoot, 'workspaces', 'hr', 'recruiting', 'pipeline.md'), 'sourcing notes\n');

        const onSuccess = vi.fn(async () => {});
        const r = await handleSettle(
            built.workdir,
            { message: 'recruiting notes', files: ['workspaces/hr/recruiting/pipeline.md'] },
            makeCtx({ hooks: { onSettleSuccess: onSuccess } }),
        );

        expect(r.ok).toBe(true);
        expect(onSuccess.mock.calls[0][0]).toEqual(['recruiting']);
    });
});
