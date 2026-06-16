import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { computeWorkspaceVisibility, canReadPath, workspaceForPath, readableBoundaries } from '../visibility';

const scopes = (...xs: string[]): ReadonlySet<string> => new Set(xs);

describe('computeWorkspaceVisibility (real FS, depth-aware)', () => {
    let root: string;

    async function ws(rel: string, fm: string): Promise<void> {
        await mkdir(path.join(root, rel), { recursive: true });
        await writeFile(path.join(root, rel, 'WORKSPACE.md'), fm);
    }

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'visibility-'));
        await ws('workspaces/product', '---\nname: product\n---\n'); // public parent
        await ws('workspaces/product/pricing', '---\nname: pricing\nread: pricing:read\n---\n'); // restricted child
        await ws('workspaces/product/pricing/esim', '---\nname: esim\n---\n'); // public grandchild
        await ws('workspaces/hr', '---\nname: hr\nread: hr:read\n---\n');
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('closes the nested read-scope leak: a public parent does NOT grant its restricted child', async () => {
        // Principal with NO scopes.
        const vis = await computeWorkspaceVisibility(root, scopes(), { isAdmin: false });

        expect(vis.readableNames.has('product')).toBe(true); // public
        expect(vis.readableNames.has('pricing')).toBe(false); // restricted — the leak we closed
        expect(vis.readableNames.has('esim')).toBe(true); // public grandchild (independent scoping)
        expect(vis.readableNames.has('hr')).toBe(false); // restricted

        // Attribution is depth-correct, and the gate follows the DEEPEST owner.
        expect(workspaceForPath(vis, 'workspaces/product/pricing/x.md')).toBe('pricing');
        expect(canReadPath(vis, 'workspaces/product/pricing/x.md')).toBe(false); // restricted child
        expect(canReadPath(vis, 'workspaces/product/overview.md')).toBe(true); // parent's own file
        expect(canReadPath(vis, 'workspaces/product/pricing/esim/rates.md')).toBe(true); // public grandchild
    });

    it('grants the restricted child when the principal holds its read scope', async () => {
        const vis = await computeWorkspaceVisibility(root, scopes('pricing:read'), { isAdmin: false });
        expect(vis.readableNames.has('pricing')).toBe(true);
        expect(canReadPath(vis, 'workspaces/product/pricing/x.md')).toBe(true);
        expect(vis.readableNames.has('hr')).toBe(false); // unrelated scope still gated
    });

    it('isAdmin sees every boundary regardless of ACL', async () => {
        const vis = await computeWorkspaceVisibility(root, scopes(), { isAdmin: true });
        for (const name of ['product', 'pricing', 'esim', 'hr']) {
            expect(vis.readableNames.has(name)).toBe(true);
        }
    });

    it('reserved system workspaces are always readable, even with a restrictive ACL', async () => {
        await ws('workspaces/_ernesto', '---\nname: _ernesto\nread: nobody:read\n---\n');
        const vis = await computeWorkspaceVisibility(root, scopes(), { isAdmin: false });
        expect(vis.readableNames.has('_ernesto')).toBe(true);
    });

    it('readableBoundaries resolves a child by its DIR, not its name', async () => {
        const vis = await computeWorkspaceVisibility(root, scopes('pricing:read'), { isAdmin: false });
        const pricing = readableBoundaries(vis).find((b) => b.name === 'pricing');
        expect(pricing?.dir).toBe('workspaces/product/pricing');
    });

    it('denies a path owned by NO boundary (out-of-tree / bare path), not defaulted-open', async () => {
        // Principal with NO scopes — but the point is attribution, not the ACL:
        // a path under no boundary must be unattributable and therefore denied.
        const vis = await computeWorkspaceVisibility(root, scopes(), { isAdmin: false });

        // Out-of-tree: a file outside `workspaces/` entirely.
        expect(workspaceForPath(vis, 'README.md')).toBe(null);
        expect(canReadPath(vis, 'README.md')).toBe(false);

        // A bare path whose dir ('workspaces/ghost') carries no WORKSPACE.md →
        // boundaryForPath finds no owner → null → denied (not the parent's gate,
        // not defaulted-open).
        expect(workspaceForPath(vis, 'workspaces/ghost/x.md')).toBe(null);
        expect(canReadPath(vis, 'workspaces/ghost/x.md')).toBe(false);

        // `workspaces/` itself is not a boundary.
        expect(workspaceForPath(vis, 'workspaces/index.md')).toBe(null);
        expect(canReadPath(vis, 'workspaces/index.md')).toBe(false);
    });

    it('admin bypass does NOT defaulted-open an out-of-tree path (attribution is independent of ACL)', async () => {
        // isAdmin floods readableNames, but attribution still yields null for a
        // path under no boundary, so the read is still denied.
        const vis = await computeWorkspaceVisibility(root, scopes(), { isAdmin: true });
        expect(workspaceForPath(vis, 'README.md')).toBe(null);
        expect(canReadPath(vis, 'README.md')).toBe(false);
        expect(canReadPath(vis, 'workspaces/ghost/x.md')).toBe(false);
    });

    it('falls back to _ernesto when there are no boundaries on disk', async () => {
        const empty = await mkdtemp(path.join(tmpdir(), 'visibility-empty-'));
        try {
            const vis = await computeWorkspaceVisibility(empty, scopes(), { isAdmin: false });
            expect([...vis.readableNames]).toEqual(['_ernesto']);
            expect(vis.all).toEqual([]);
        } finally {
            await rm(empty, { recursive: true, force: true });
        }
    });
});
