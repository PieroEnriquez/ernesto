import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import {
    scanWorkspaceBoundaries,
    boundaryForName,
    boundaryForPath,
} from '../boundaries';

describe('workspace boundaries (FS-derived resolver)', () => {
    let root: string;

    async function ws(rel: string): Promise<void> {
        await mkdir(path.join(root, rel), { recursive: true });
        await writeFile(path.join(root, rel, 'WORKSPACE.md'), '---\nname: x\n---\n');
    }
    async function file(rel: string): Promise<void> {
        await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await writeFile(path.join(root, rel), 'x');
    }

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'boundaries-'));
        await ws('workspaces/hr');
        await ws('workspaces/hr/recruiting'); // nested sub-workspace
        await ws('workspaces/product');
        await ws('workspaces/product/pricing'); // nested
        // Pruned: an archived sub-workspace + an extracted mirror must NOT count.
        await ws('workspaces/hr/archive/old');
        await ws('workspaces/product/extracted/buried');
        // A doc-project (PROJECT.md, no WORKSPACE.md) is NOT a boundary.
        await file('workspaces/hr/projects/onboarding/PROJECT.md');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('discovers nested boundaries and prunes archive/ + extracted/', async () => {
        const b = await scanWorkspaceBoundaries(root);
        const dirs = b.map((x) => x.dir).sort();
        expect(dirs).toEqual([
            'workspaces/hr',
            'workspaces/hr/recruiting',
            'workspaces/product',
            'workspaces/product/pricing',
        ]);
    });

    it('does not treat a PROJECT.md-only folder as a boundary', async () => {
        const b = await scanWorkspaceBoundaries(root);
        expect(b.some((x) => x.dir.includes('projects/onboarding'))).toBe(false);
    });

    it('resolves a leaf name to its current (possibly nested) path', async () => {
        const b = await scanWorkspaceBoundaries(root);
        expect(boundaryForName(b, 'recruiting')?.dir).toBe('workspaces/hr/recruiting');
        expect(boundaryForName(b, 'pricing')?.dir).toBe('workspaces/product/pricing');
        expect(boundaryForName(b, 'hr')?.dir).toBe('workspaces/hr');
        expect(boundaryForName(b, 'nope')).toBeUndefined();
    });

    it('attributes a path to its DEEPEST enclosing boundary', async () => {
        const b = await scanWorkspaceBoundaries(root);
        expect(boundaryForPath(b, 'workspaces/hr/recruiting/jobs/x.md')?.name).toBe('recruiting');
        expect(boundaryForPath(b, 'workspaces/hr/leave-policy.md')?.name).toBe('hr');
        expect(boundaryForPath(b, 'workspaces/product/pricing/WORKSPACE.md')?.name).toBe('pricing');
        expect(boundaryForPath(b, 'README.md')).toBeUndefined();
    });
});
