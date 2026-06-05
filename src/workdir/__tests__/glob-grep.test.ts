/**
 * Coverage for the upgraded `FsAdapter.glob` / `FsAdapter.grep` surface:
 *   - bash-style globs (brace expansion, character classes, negation)
 *   - path-restricted glob
 *   - newest-first ordering (node adapter, real mtime)
 *   - grep output modes (files_with_matches, content, count)
 *   - grep glob/type/case/context filters
 *   - in-memory ↔ node adapter parity for the cases both can serve
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile } from 'fs/promises';
import * as path from 'path';
import { makeInMemoryFsAdapter } from '../in-memory-adapters';
import { makeTempTree, type TempTree } from '../../__tests__/kit';

const enc = (s: string) => new TextEncoder().encode(s);

const FIXTURE: Record<string, string> = {
    'workspaces/hr/INDEX.md': '# hr\nleave: 25 days\nhealth: covered\n',
    'workspaces/hr/routes/_index.md': '# routes\n',
    'workspaces/hr/routes/a.ts': 'export const a = 1;\n',
    'workspaces/hr/routes/b.tsx': 'export const b = 2;\n',
    'workspaces/hr/routes/c.js': 'module.exports = 3;\n',
    'workspaces/cs/INDEX.md': '# cs\nLEAVE: rare\n',
    'workspaces/legal/INDEX.md': '# legal\n',
};

describe('Node FsAdapter — glob (picomatch)', () => {
    let tree: TempTree;
    let fs: TempTree['fs'];
    beforeEach(async () => {
        tree = await makeTempTree(FIXTURE, 'glob-grep-test-');
        fs = tree.fs;
    });
    afterEach(async () => {
        await tree.cleanup();
    });

    it('matches `**` recursive', async () => {
        const out = await fs.glob('workspaces/**/*.md');
        expect(out.sort()).toEqual([
            'workspaces/cs/INDEX.md',
            'workspaces/hr/INDEX.md',
            'workspaces/hr/routes/_index.md',
            'workspaces/legal/INDEX.md',
        ]);
    });

    it('supports brace expansion {ts,tsx}', async () => {
        const out = await fs.glob('workspaces/hr/routes/*.{ts,tsx}');
        expect(out.sort()).toEqual([
            'workspaces/hr/routes/a.ts',
            'workspaces/hr/routes/b.tsx',
        ]);
    });

    it('supports character classes [a-b]', async () => {
        const out = await fs.glob('workspaces/hr/routes/[a-b].ts*');
        expect(out.sort()).toEqual([
            'workspaces/hr/routes/a.ts',
            'workspaces/hr/routes/b.tsx',
        ]);
    });

    it('honors `path` to restrict the search subtree', async () => {
        // Pattern is workdir-relative; `path` limits the walk root.
        const out = await fs.glob('workspaces/hr/**/*.ts', { path: 'workspaces/hr' });
        expect(out.sort()).toEqual(['workspaces/hr/routes/a.ts']);
    });

    it('rejects `..` segments in `path`', async () => {
        await expect(fs.glob('**/*', { path: '../etc' })).rejects.toThrow('parent_segment_not_allowed');
    });

    it('returns newest-first by mtime', async () => {
        // Touch one file last so it has the newest mtime.
        await writeFile(path.join(tree.dir, 'workspaces/hr/INDEX.md'), '# hr v2\n');
        const out = await fs.glob('workspaces/**/INDEX.md');
        expect(out[0]).toBe('workspaces/hr/INDEX.md');
    });
});

describe('Node FsAdapter — grep (ripgrep)', () => {
    let tree: TempTree;
    let fs: TempTree['fs'];
    beforeEach(async () => {
        tree = await makeTempTree(FIXTURE, 'glob-grep-test-');
        fs = tree.fs;
    });
    afterEach(async () => {
        await tree.cleanup();
    });

    it('default mode is files_with_matches', async () => {
        const r = await fs.grep({ pattern: 'leave' });
        expect(r.mode).toBe('files_with_matches');
        // Case-sensitive default: only hr matches (cs has uppercase).
        expect(r.lines.sort()).toEqual(['workspaces/hr/INDEX.md']);
    });

    it('case-insensitive flag matches both cases', async () => {
        const r = await fs.grep({ pattern: 'leave', caseInsensitive: true });
        expect(r.lines.sort()).toEqual([
            'workspaces/cs/INDEX.md',
            'workspaces/hr/INDEX.md',
        ]);
    });

    it('content mode emits `path:line:text`', async () => {
        const r = await fs.grep({ pattern: 'leave: [0-9]+', outputMode: 'content' });
        expect(r.lines.some(l => /workspaces\/hr\/INDEX\.md:\d+:leave: 25 days/.test(l))).toBe(true);
    });

    it('count mode emits `path:n`', async () => {
        const r = await fs.grep({ pattern: 'leave', outputMode: 'count', caseInsensitive: true });
        expect(r.lines.length).toBe(2);
        expect(r.lines.every(l => /:\d+$/.test(l))).toBe(true);
    });

    it('glob filter restricts file set', async () => {
        const r = await fs.grep({ pattern: 'export', glob: '*.tsx', outputMode: 'files_with_matches' });
        expect(r.lines).toEqual(['workspaces/hr/routes/b.tsx']);
    });

    it('type filter restricts to ripgrep type set', async () => {
        const r = await fs.grep({ pattern: 'export', type: 'ts', outputMode: 'files_with_matches' });
        expect(r.lines.sort()).toEqual([
            'workspaces/hr/routes/a.ts',
            'workspaces/hr/routes/b.tsx',
        ]);
    });

    it('context-after lines surface in content mode', async () => {
        const r = await fs.grep({
            pattern: 'leave: 25',
            outputMode: 'content',
            contextAfter: 1,
        });
        // Expect the next line ("health: covered") to also appear.
        expect(r.lines.some(l => l.includes('health: covered'))).toBe(true);
    });

    it('headLimit caps and marks truncated', async () => {
        const r = await fs.grep({
            pattern: '.',
            outputMode: 'content',
            headLimit: 3,
        });
        expect(r.lines.length).toBe(3);
        expect(r.truncated).toBe(true);
    });

    it('path restricts the search', async () => {
        const r = await fs.grep({ pattern: 'export', path: 'workspaces/hr/routes' });
        expect(r.lines.every(l => l.startsWith('workspaces/hr/routes/'))).toBe(true);
    });

    it('empty result set is not an error', async () => {
        const r = await fs.grep({ pattern: 'absolutely-nowhere-token' });
        expect(r.lines).toEqual([]);
        expect(r.truncated).toBe(false);
    });
});

describe('InMemory FsAdapter — glob / grep parity', () => {
    function seed() {
        const fs = makeInMemoryFsAdapter();
        // Use awaitless sequencing inline.
        return (async () => {
            for (const [p, content] of Object.entries(FIXTURE)) {
                await fs.writeFile(p, enc(content));
            }
            return fs;
        })();
    }

    it('brace expansion + char classes match the same files', async () => {
        const fs = await seed();
        const out = await fs.glob('workspaces/hr/routes/*.{ts,tsx}');
        expect(out.sort()).toEqual([
            'workspaces/hr/routes/a.ts',
            'workspaces/hr/routes/b.tsx',
        ]);
    });

    it('grep default = files_with_matches, case-sensitive', async () => {
        const fs = await seed();
        const r = await fs.grep({ pattern: 'leave' });
        expect(r.lines).toEqual(['workspaces/hr/INDEX.md']);
    });

    it('grep count mode', async () => {
        const fs = await seed();
        const r = await fs.grep({ pattern: 'leave', caseInsensitive: true, outputMode: 'count' });
        expect(r.lines.length).toBe(2);
    });

    it('grep content mode includes line numbers', async () => {
        const fs = await seed();
        const r = await fs.grep({ pattern: 'leave: 25', outputMode: 'content' });
        expect(r.lines.some(l => /:\d+:leave: 25 days/.test(l))).toBe(true);
    });

    it('grep glob filter', async () => {
        const fs = await seed();
        const r = await fs.grep({ pattern: 'export', glob: '*.tsx' });
        expect(r.lines).toEqual(['workspaces/hr/routes/b.tsx']);
    });
});
