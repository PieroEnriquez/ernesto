import { describe, it, expect } from 'vitest';
import { makeOverlayView, emptyPatch, type FsReader, type FsReaderDirent, type WorkspacePatch } from '../overlay';

const scopes = (...xs: string[]): ReadonlySet<string> => new Set(xs);

/**
 * A tiny in-memory {@link FsReader} over a flat `path → content` map. Directory
 * membership is derived from the prefixes of file paths, so the fixture only
 * needs to list FILES — exactly the shape the overlay's lower layer must
 * tolerate. Mirrors the POSIX, tree-relative path convention.
 */
function makeMemoryFs(files: Record<string, string>): FsReader {
    const has = (rel: string) => Object.prototype.hasOwnProperty.call(files, rel);
    const isDir = (rel: string) => {
        const prefix = rel === '' ? '' : `${rel}/`;
        return Object.keys(files).some((p) => p.startsWith(prefix) && p !== rel);
    };
    return {
        async readFile(rel) {
            if (!has(rel)) throw new Error(`ENOENT: ${rel}`);
            return files[rel];
        },
        async readdir(rel) {
            const prefix = rel === '' ? '' : `${rel}/`;
            const fileNames = new Set<string>();
            const dirNames = new Set<string>();
            for (const p of Object.keys(files)) {
                if (!p.startsWith(prefix)) continue;
                const rest = p.slice(prefix.length);
                if (rest === '') continue;
                const slash = rest.indexOf('/');
                if (slash === -1) fileNames.add(rest);
                else dirNames.add(rest.slice(0, slash));
            }
            if (fileNames.size === 0 && dirNames.size === 0 && !isDir(rel)) {
                throw new Error(`ENOTDIR: ${rel}`);
            }
            const out: FsReaderDirent[] = [];
            for (const name of dirNames) out.push(dirent(name, false));
            for (const name of fileNames) if (!dirNames.has(name)) out.push(dirent(name, true));
            return out;
        },
        async stat(rel) {
            if (has(rel)) return { isFile: () => true, isDirectory: () => false };
            if (isDir(rel)) return { isFile: () => false, isDirectory: () => true };
            throw new Error(`ENOENT: ${rel}`);
        },
    };
}

function dirent(name: string, isFile: boolean): FsReaderDirent {
    return { name, isFile: () => isFile, isDirectory: () => !isFile };
}

describe('OverlayView — read resolution (master-FS ⊕ patch)', () => {
    const lower = makeMemoryFs({
        'workspaces/hr/WORKSPACE.md': '---\nname: hr\n---\n',
        'workspaces/hr/handbook.md': 'lower handbook\n',
        'workspaces/cs/WORKSPACE.md': '---\nname: cs\n---\n',
        'workspaces/cs/faq.md': 'lower faq\n',
    });

    it('readFile returns patch content when present, else the lower layer', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: { 'workspaces/hr/handbook.md': { content: 'patched handbook\n' } },
        };
        const view = makeOverlayView(lower, patch);
        expect(await view.readFile('workspaces/hr/handbook.md')).toBe('patched handbook\n');
        expect(await view.readFile('workspaces/cs/faq.md')).toBe('lower faq\n');
    });

    it('a deletion tombstone hides the lower file (readFile rejects, exists false)', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: { 'workspaces/hr/handbook.md': { deleted: true } },
        };
        const view = makeOverlayView(lower, patch);
        await expect(view.readFile('workspaces/hr/handbook.md')).rejects.toThrow();
        expect(await view.exists('workspaces/hr/handbook.md')).toBe(false);
        // a sibling untouched lower file is still visible
        expect(await view.exists('workspaces/hr/WORKSPACE.md')).toBe(true);
    });

    it('exists is true for a patch-added file and for surviving lower files', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: { 'workspaces/hr/new.md': { content: 'new\n' } },
        };
        const view = makeOverlayView(lower, patch);
        expect(await view.exists('workspaces/hr/new.md')).toBe(true);
        expect(await view.exists('workspaces/hr/handbook.md')).toBe(true);
        expect(await view.exists('workspaces/hr/absent.md')).toBe(false);
    });

    it('listDir unions lower + patch-added entries, minus deletions, sorted', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: {
                'workspaces/hr/added.md': { content: 'a\n' },
                'workspaces/hr/handbook.md': { deleted: true },
            },
        };
        const view = makeOverlayView(lower, patch);
        const names = (await view.listDir('workspaces/hr')).map((e) => e.name);
        expect(names).toEqual(['WORKSPACE.md', 'added.md']); // handbook.md deleted, sorted
    });

    it('listDir surfaces a patch-added nested directory the lower layer lacks', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: { 'workspaces/hr/recruiting/WORKSPACE.md': { content: '---\nname: recruiting\n---\n' } },
        };
        const view = makeOverlayView(lower, patch);
        const entries = await view.listDir('workspaces/hr');
        const recruiting = entries.find((e) => e.name === 'recruiting');
        expect(recruiting).toBeDefined();
        expect(recruiting!.isDirectory()).toBe(true);
    });
});

describe('OverlayView — boundary merge over the overlay', () => {
    const lower = makeMemoryFs({
        'workspaces/hr/WORKSPACE.md': '---\nname: hr\n---\n',
        'workspaces/cs/WORKSPACE.md': '---\nname: cs\n---\n',
    });

    it('a patch that adds workspaces/x/WORKSPACE.md introduces a NEW boundary', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: { 'workspaces/x/WORKSPACE.md': { content: '---\nname: x\n---\n' } },
        };
        const view = makeOverlayView(lower, patch);
        const names = (await view.scanBoundaries()).map((b) => b.name).sort();
        expect(names).toEqual(['cs', 'hr', 'x']);
    });

    it('a patch-added NESTED workspace is a first-class boundary at its depth', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: {
                'workspaces/hr/recruiting/WORKSPACE.md': { content: '---\nname: recruiting\n---\n' },
            },
        };
        const view = makeOverlayView(lower, patch);
        const boundaries = await view.scanBoundaries();
        const recruiting = boundaries.find((b) => b.name === 'recruiting');
        expect(recruiting?.dir).toBe('workspaces/hr/recruiting');
    });

    it('a patch that deletes a WORKSPACE.md removes that boundary', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: { 'workspaces/cs/WORKSPACE.md': { deleted: true } },
        };
        const view = makeOverlayView(lower, patch);
        const names = (await view.scanBoundaries()).map((b) => b.name).sort();
        expect(names).toEqual(['hr']);
    });
});

describe('OverlayView — merged-view visibility (scope gate over the overlay)', () => {
    const lower = makeMemoryFs({
        'workspaces/product/WORKSPACE.md': '---\nname: product\n---\n', // public
        'workspaces/hr/WORKSPACE.md': '---\nname: hr\nread: hr:read\n---\n', // restricted
    });

    it('gates a patch-added restricted boundary exactly like the on-disk model', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: {
                'workspaces/secret/WORKSPACE.md': { content: '---\nname: secret\nread: secret:read\n---\n' },
            },
        };
        const view = makeOverlayView(lower, patch);

        const noScopes = await view.computeVisibility(scopes(), { isAdmin: false });
        expect(noScopes.readableNames.has('product')).toBe(true); // public
        expect(noScopes.readableNames.has('hr')).toBe(false); // restricted lower
        expect(noScopes.readableNames.has('secret')).toBe(false); // restricted patch-added

        const withScope = await view.computeVisibility(scopes('secret:read'), { isAdmin: false });
        expect(withScope.readableNames.has('secret')).toBe(true);
    });

    it('isAdmin sees every merged boundary regardless of ACL', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: {
                'workspaces/secret/WORKSPACE.md': { content: '---\nname: secret\nread: secret:read\n---\n' },
            },
        };
        const view = makeOverlayView(lower, patch);
        const vis = await view.computeVisibility(scopes(), { isAdmin: true });
        for (const name of ['product', 'hr', 'secret']) {
            expect(vis.readableNames.has(name)).toBe(true);
        }
    });

    it('reads are fresh on a moving lower layer (re-overlay over new master)', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: { 'workspaces/product/notes.md': { content: 'my draft\n' } },
        };
        // master moves: product gets a new lower file the patch never saw.
        const movedLower = makeMemoryFs({
            'workspaces/product/WORKSPACE.md': '---\nname: product\n---\n',
            'workspaces/product/changelog.md': 'master moved\n',
        });
        const view = makeOverlayView(movedLower, patch);
        expect(await view.readFile('workspaces/product/notes.md')).toBe('my draft\n'); // patch
        expect(await view.readFile('workspaces/product/changelog.md')).toBe('master moved\n'); // fresh lower
    });
});

describe('OverlayView — NEGATIVE: an unreadable WORKSPACE.md fails CLOSED', () => {
    // A lower layer where one boundary's WORKSPACE.md exists (stat/readdir see
    // it, so the dir IS a boundary) but readFile REJECTS for that one path —
    // modeling a contract that cannot be read (corrupt blob, deletion tombstone
    // over the contract while sibling patch files keep the dir alive, transient
    // I/O error). The secure property under test (overlay.ts:239-244): an
    // unreadable contract is NEVER granted by default — it is excluded from
    // readableNames. We do NOT mock computeVisibility / canRead (the enforcer);
    // we drive the REAL view with a reader that decouples stat from readFile.
    function unreadableContractFs(files: Record<string, string>, unreadablePath: string): FsReader {
        const base = makeMemoryFs(files);
        return {
            async readFile(rel) {
                if (rel === unreadablePath) {
                    throw new Error(`EIO: cannot read contract ${rel}`);
                }
                return base.readFile(rel);
            },
            readdir: (rel) => base.readdir(rel),
            stat: (rel) => base.stat(rel),
        };
    }

    it('excludes a boundary whose WORKSPACE.md read throws (not readable-by-default)', async () => {
        const lower = unreadableContractFs(
            {
                // public, fully readable — the control
                'workspaces/product/WORKSPACE.md': '---\nname: product\n---\n',
                // boundary exists (stat sees the .md) but its contract is unreadable
                'workspaces/vault/WORKSPACE.md': '---\nname: vault\n---\n',
                'workspaces/vault/secret.md': 'classified\n',
            },
            'workspaces/vault/WORKSPACE.md',
        );
        const view = makeOverlayView(lower, emptyPatch('base'));

        // The dir is still SEEN as a boundary (its WORKSPACE.md exists via stat)…
        const boundaryNames = (await view.scanBoundaries()).map((b) => b.name).sort();
        expect(boundaryNames).toEqual(['product', 'vault']);

        // …yet because its contract cannot be READ, it must be excluded — even
        // for a principal carrying NO scopes and admin=false.
        const vis = await view.computeVisibility(scopes(), { isAdmin: false });
        expect(vis.readableNames.has('vault')).toBe(false); // FAIL-CLOSED
        expect(vis.readableNames.has('product')).toBe(true); // control: public stays readable

        // And it is not silently granted to a scope-bearing-but-irrelevant caller.
        const withOther = await view.computeVisibility(scopes('hr:read', 'cs:read'), { isAdmin: false });
        expect(withOther.readableNames.has('vault')).toBe(false);
    });

    it('an unreadable contract kept alive by a sibling patch file is still fail-closed', async () => {
        // Concretely model the brief's tombstone case: the contract is deletion-
        // tombstoned by the patch (so readFile rejects) while a SECOND patch file
        // under the same dir keeps it a live boundary in the merged view.
        const lower = makeMemoryFs({
            'workspaces/product/WORKSPACE.md': '---\nname: product\n---\n',
            'workspaces/vault/WORKSPACE.md': '---\nname: vault\n---\n',
        });
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: {
                'workspaces/vault/WORKSPACE.md': { deleted: true }, // contract unreadable
                'workspaces/vault/notes.md': { content: 'keeps the dir alive\n' },
            },
        };
        const view = makeOverlayView(lower, patch);

        // The patch tombstones the contract: it no longer exists in the merged
        // view, so the dir is NOT a boundary and 'vault' is simply absent — which
        // is itself fail-closed (never readable-by-default).
        const vis = await view.computeVisibility(scopes(), { isAdmin: false });
        expect(vis.readableNames.has('vault')).toBe(false);
        expect(vis.readableNames.has('product')).toBe(true);
    });
});

describe('OverlayView — NEGATIVE: scanBoundaries prunes generated mirrors', () => {
    // PRUNE_DIRS (overlay.ts:37) must never be descended into. A WORKSPACE.md
    // placed under a generated mirror (extracted/) must NOT be promoted to a
    // boundary in the merged overlay view, and a restricted contract buried
    // there must NOT leak into readableNames. We exercise the REAL scanner.
    const lower = makeMemoryFs({
        'workspaces/hr/WORKSPACE.md': '---\nname: hr\n---\n',
        'workspaces/hr/handbook.md': 'lower handbook\n',
    });

    it('a WORKSPACE.md under extracted/ is not a boundary and not readable', async () => {
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: {
                // a restricted contract buried in a generated mirror
                'workspaces/hr/extracted/buried/WORKSPACE.md': {
                    content: '---\nname: buried\nread: secret:read\n---\n',
                },
            },
        };
        const view = makeOverlayView(lower, patch);

        const boundaries = await view.scanBoundaries();
        expect(boundaries.some((b) => b.name === 'buried')).toBe(false);
        // sanity: the legit boundary above the mirror is still found
        expect(boundaries.some((b) => b.name === 'hr')).toBe(true);

        const vis = await view.computeVisibility(scopes(), { isAdmin: false });
        expect(vis.readableNames.has('buried')).toBe(false);

        // Even carrying the very scope the buried contract names, it must not
        // become readable — it was never a boundary at all.
        const withScope = await view.computeVisibility(scopes('secret:read'), { isAdmin: false });
        expect(withScope.readableNames.has('buried')).toBe(false);
    });

    it('a top-level WORKSPACE.md under each PRUNE_DIR is never a boundary', async () => {
        // Cover every prune subtree at the workspaces/<x>/<prune>/ depth.
        const patch: WorkspacePatch = {
            baseSha: 'base',
            files: {
                'workspaces/hr/extracted/a/WORKSPACE.md': { content: '---\nname: a\n---\n' },
                'workspaces/hr/attached/b/WORKSPACE.md': { content: '---\nname: b\n---\n' },
                'workspaces/hr/_results/c/WORKSPACE.md': { content: '---\nname: c\n---\n' },
                'workspaces/hr/archive/d/WORKSPACE.md': { content: '---\nname: d\n---\n' },
                'workspaces/hr/node_modules/e/WORKSPACE.md': { content: '---\nname: e\n---\n' },
            },
        };
        const view = makeOverlayView(lower, patch);
        const names = (await view.scanBoundaries()).map((b) => b.name).sort();
        // Only the legit hr boundary survives; every buried one is pruned.
        expect(names).toEqual(['hr']);
    });
});

describe('emptyPatch — the read-only / clean-main principal', () => {
    it('an empty patch is a pure pass-through to the lower layer', async () => {
        const lower = makeMemoryFs({ 'workspaces/hr/WORKSPACE.md': '---\nname: hr\n---\n' });
        const view = makeOverlayView(lower, emptyPatch('sha123'));
        expect(await view.readFile('workspaces/hr/WORKSPACE.md')).toBe('---\nname: hr\n---\n');
        expect((await view.scanBoundaries()).map((b) => b.name)).toEqual(['hr']);
    });
});
