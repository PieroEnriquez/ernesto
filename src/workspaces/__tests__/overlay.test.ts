import { describe, it, expect } from 'vitest';
import {
    makeOverlayView,
    emptyPatch,
    type FsReader,
    type FsReaderDirent,
    type WorkspacePatch,
} from '../overlay';

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
        expect(noScopes.readableNames.has('product')).toBe(true);  // public
        expect(noScopes.readableNames.has('hr')).toBe(false);      // restricted lower
        expect(noScopes.readableNames.has('secret')).toBe(false);  // restricted patch-added

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

describe('emptyPatch — the read-only / clean-main principal', () => {
    it('an empty patch is a pure pass-through to the lower layer', async () => {
        const lower = makeMemoryFs({ 'workspaces/hr/WORKSPACE.md': '---\nname: hr\n---\n' });
        const view = makeOverlayView(lower, emptyPatch('sha123'));
        expect(await view.readFile('workspaces/hr/WORKSPACE.md')).toBe('---\nname: hr\n---\n');
        expect((await view.scanBoundaries()).map((b) => b.name)).toEqual(['hr']);
    });
});
