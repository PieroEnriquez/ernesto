import { describe, it, expect } from 'vitest';
import { overlayToDiff } from '../overlay-to-diff';
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
        const diff = overlayToDiff(patch);
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
        const diff = overlayToDiff(patch);
        expect(diff).toContain('deleted file mode 100644');
        expect(diff).toContain('--- a/workspaces/hr/old.md');
        expect(diff).toContain('+++ /dev/null');
    });

    it('an empty patch projects to an empty diff', () => {
        expect(overlayToDiff({ baseSha: 'base', files: {} })).toBe('');
    });
});
