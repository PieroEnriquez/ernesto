/**
 * Tests for `WorkspaceResultCache` — the workspace-backed result-cache
 * store. Files live under `<workdirRoot>/<subdir>/<key>.json` and round-trip
 * through the same `ResultCacheStore` contract `InMemoryResultCache`
 * implements.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DispatchPreContext } from '../middleware';
import { WorkspaceResultCache } from '../middleware/workspace-result-cache';
import { userPrincipal } from '../principal';

function ctxFor(workdirRoot: string | undefined): DispatchPreContext {
    return {
        runId: 'run-id',
        kind: 'wf',
        inputs: {},
        principal: userPrincipal('u', []),
        opts: {},
        annotations: {},
        ...(workdirRoot ? { workdirRoot } : {}),
    } as DispatchPreContext;
}

describe('WorkspaceResultCache', () => {
    let workdir: string;

    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), 'wrc-test-'));
    });

    afterEach(() => {
        rmSync(workdir, { recursive: true, force: true });
    });

    it('round-trips a cached entry through the filesystem', async () => {
        const store = new WorkspaceResultCache({ now: () => 1_000_000 });
        const ctx = ctxFor(workdir);
        const entry = { output: { rows: 42 }, expiresAt: 1_500_000 };

        await store.set('abc123', entry, ctx);
        const got = await store.get('abc123', ctx);

        expect(got).toEqual(entry);
    });

    it('returns undefined on missing key (clean miss, not error)', async () => {
        const store = new WorkspaceResultCache();
        const ctx = ctxFor(workdir);

        const got = await store.get('never-written', ctx);

        expect(got).toBeUndefined();
    });

    it('treats an expired entry as a miss', async () => {
        const clock = { ms: 1_000_000 };
        const store = new WorkspaceResultCache({ now: () => clock.ms });
        const ctx = ctxFor(workdir);

        await store.set('exp', { output: { v: 1 }, expiresAt: 1_500_000 }, ctx);
        expect(await store.get('exp', ctx)).toBeDefined();

        clock.ms = 2_000_000;
        expect(await store.get('exp', ctx)).toBeUndefined();
    });

    it('treats a corrupt JSON file as a miss (next set overwrites)', async () => {
        const store = new WorkspaceResultCache();
        const ctx = ctxFor(workdir);
        // Simulate partial write / corruption.
        const path = join(workdir, '_cache/result-cache', 'corrupt.json');
        const dir = join(workdir, '_cache/result-cache');
        await new Promise<void>((res, rej) => {
            try {
                require('node:fs').mkdirSync(dir, { recursive: true });
                writeFileSync(path, '{not-valid-json', 'utf8');
                res();
            } catch (e) {
                rej(e as Error);
            }
        });

        expect(await store.get('corrupt', ctx)).toBeUndefined();

        await store.set(
            'corrupt',
            { output: { fresh: true }, expiresAt: Number.MAX_SAFE_INTEGER },
            ctx,
        );
        expect(await store.get('corrupt', ctx)).toBeDefined();
    });

    it('writes to a custom subdir + extension', async () => {
        const store = new WorkspaceResultCache({
            subdir: 'compiled-fragments',
            extension: 'playwright.md',
        });
        const ctx = ctxFor(workdir);

        await store.set(
            'aaaaaaaaaaaa',
            { output: 'await page.click("...");', expiresAt: Number.MAX_SAFE_INTEGER },
            ctx,
        );

        const expectedPath = join(
            workdir,
            'compiled-fragments',
            'aaaaaaaaaaaa.playwright.md',
        );
        // The file exists at the expected location.
        const raw = readFileSync(expectedPath, 'utf8');
        expect(raw).toContain('await page.click');
    });

    it('returns undefined when no workdirRoot is bound (graceful miss, not error)', async () => {
        const store = new WorkspaceResultCache();
        const ctx = ctxFor(undefined);

        expect(await store.get('any', ctx)).toBeUndefined();
    });

    it('silently no-ops on set when no workdirRoot is bound', async () => {
        const store = new WorkspaceResultCache();
        const ctx = ctxFor(undefined);

        // Should not throw; should also not write anywhere.
        await expect(
            store.set('any', { output: 1, expiresAt: Number.MAX_SAFE_INTEGER }, ctx),
        ).resolves.toBeUndefined();
    });

    it('rejects keys containing path-traversal characters', async () => {
        const store = new WorkspaceResultCache();
        const ctx = ctxFor(workdir);

        await expect(
            store.get('../escape', ctx),
        ).rejects.toThrow(/unsafe key/);
        await expect(
            store.set('a/b', { output: 1, expiresAt: 0 }, ctx),
        ).rejects.toThrow(/unsafe key/);
        await expect(
            store.get('a\\b', ctx),
        ).rejects.toThrow(/unsafe key/);
    });

    it('is durable across store instances against the same workdir', async () => {
        const ctx = ctxFor(workdir);
        const first = new WorkspaceResultCache({ now: () => 1_000 });
        await first.set(
            'shared',
            { output: { v: 99 }, expiresAt: 9_999_999 },
            ctx,
        );

        // A fresh instance — separate process simulation — reads it back.
        const second = new WorkspaceResultCache({ now: () => 1_000 });
        expect(await second.get('shared', ctx)).toEqual({
            output: { v: 99 },
            expiresAt: 9_999_999,
        });
    });
});
