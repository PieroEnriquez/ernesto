import { describe, it, expect } from 'vitest';
import { overlayToDiff, diffToOverlay } from '../overlay-to-diff';
import type { WorkspacePatch } from '../../workspaces/overlay';

describe('overlayToDiff — content-overlay → unified diff', () => {
    it('emits a new-file hunk per present path, sorted, git-apply shaped', () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: {
                'workspaces/hr/handbook.md': { content: 'one\ntwo\n' },
                'workspaces/cs/faq.md': { content: 'q\n' },
            },
        };
        const diff = overlayToDiff('base', patch);
        // sorted: cs before hr
        expect(diff.indexOf('a/workspaces/cs/faq.md')).toBeLessThan(diff.indexOf('a/workspaces/hr/handbook.md'));
        expect(diff).toContain('diff --git a/workspaces/hr/handbook.md b/workspaces/hr/handbook.md');
        expect(diff).toContain('new file mode 100644');
        expect(diff).toContain('--- /dev/null');
        expect(diff).toContain('+++ b/workspaces/hr/handbook.md');
        expect(diff).toContain('+one');
        expect(diff).toContain('+two');
    });

    it('emits a deleted-file marker for a tombstone', () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: { 'workspaces/hr/old.md': { deleted: true } },
        };
        const diff = overlayToDiff('base', patch);
        expect(diff).toContain('deleted file mode 100644');
        expect(diff).toContain('--- a/workspaces/hr/old.md');
        expect(diff).toContain('+++ /dev/null');
    });

    it('an empty patch projects to an empty diff', () => {
        expect(overlayToDiff('base', { baseSha: 'base', files: {} })).toBe('');
    });
});

describe('content-overlay ↔ diff round trip (lossless)', () => {
    const cases: Array<{ name: string; patch: WorkspacePatch }> = [
        {
            name: 'multi-file add + delete mix',
            patch: {
                baseSha: 'sha-1',
                files: {
                    'workspaces/hr/WORKSPACE.md': { content: '---\nname: hr\n---\n' },
                    'workspaces/hr/handbook.md': { content: 'line a\nline b\n' },
                    'workspaces/cs/old.md': { deleted: true },
                },
            },
        },
        {
            name: 'file with NO trailing newline',
            patch: {
                baseSha: 'sha-2',
                files: { 'workspaces/x/no-nl.md': { content: 'no newline at end' } },
            },
        },
        {
            name: 'empty-content file',
            patch: {
                baseSha: 'sha-3',
                files: { 'workspaces/x/empty.md': { content: '' } },
            },
        },
        {
            name: 'empty patch',
            patch: { baseSha: 'sha-4', files: {} },
        },
    ];

    for (const { name, patch } of cases) {
        it(`round-trips: ${name}`, () => {
            const diff = overlayToDiff(patch.baseSha, patch);
            const back = diffToOverlay(patch.baseSha, diff);
            expect(back).toEqual(patch);
        });
    }

    it('diffToOverlay rejects a malformed block', () => {
        expect(() => diffToOverlay('base', 'not a diff at all\n')).toThrow();
    });
});
