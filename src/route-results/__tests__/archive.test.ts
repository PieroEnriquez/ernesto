import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { archiveRouteResult, ARCHIVE_MAX_BYTES } from '../archive';

let WORKDIR = '';

beforeAll(async () => {
    WORKDIR = await fs.mkdtemp(path.join(os.tmpdir(), 'ernesto-archive-test-'));
});
afterAll(async () => {
    if (WORKDIR) await fs.rm(WORKDIR, { recursive: true, force: true });
});

describe('archiveRouteResult', () => {
    it('writes a file at workspaces/<ws>/_results/<ts>--<slug>.json and returns the relative path', async () => {
        const rel = await archiveRouteResult({
            workdir: WORKDIR,
            uri: 'redshift://revenue-breakdown',
            params: { since: '2026-01-01' },
            runId: 'r-test-1',
            data: { regions: [{ region: 'EU', revenue_usd: 100 }] },
        });
        expect(rel).toMatch(
            /^workspaces\/redshift\/_results\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z--revenue-breakdown\.json$/,
        );
        const abs = path.join(WORKDIR, rel);
        const txt = await fs.readFile(abs, 'utf8');
        const parsed = JSON.parse(txt);
        expect(parsed.uri).toBe('redshift://revenue-breakdown');
        expect(parsed.params).toEqual({ since: '2026-01-01' });
        expect(parsed.runId).toBe('r-test-1');
        expect(typeof parsed.ts).toBe('string');
        expect(parsed.data).toEqual({
            regions: [{ region: 'EU', revenue_usd: 100 }],
        });
    });

    it('infers workspace from the URI scheme part before ://', async () => {
        const rel = await archiveRouteResult({
            workdir: WORKDIR,
            uri: 'code://list-prs-backend',
            params: {},
            runId: 'r-test-2',
            data: { prs: [] },
        });
        expect(rel.startsWith('workspaces/code/_results/')).toBe(true);
        expect(rel.endsWith('--list-prs-backend.json')).toBe(true);
    });

    it('truncates and flags when data exceeds the byte cap', async () => {
        // Build a string that, when JSON.stringify'd, blows past the cap.
        const huge = 'x'.repeat(ARCHIVE_MAX_BYTES + 10);
        const warn = vi.fn();
        const rel = await archiveRouteResult({
            workdir: WORKDIR,
            uri: 'test://huge',
            params: {},
            runId: 'r-test-3',
            data: { blob: huge },
            log: { warn },
        });
        const parsed = JSON.parse(
            await fs.readFile(path.join(WORKDIR, rel), 'utf8'),
        );
        expect(parsed.truncated).toBe(true);
        expect(parsed.originalByteLength).toBeGreaterThan(ARCHIVE_MAX_BYTES);
        expect(parsed.data).toMatchObject({ __truncated: true });
        expect(warn).toHaveBeenCalledOnce();
    });

    it('atomic write — no .tmp leftover after success', async () => {
        const rel = await archiveRouteResult({
            workdir: WORKDIR,
            uri: 'test://atomic',
            params: {},
            runId: 'r-test-4',
            data: { ok: true },
        });
        const dir = path.dirname(path.join(WORKDIR, rel));
        const entries = await fs.readdir(dir);
        expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
    });

    it('recursively mkdirs the parent directory', async () => {
        // Fresh nested workdir — parent does not exist yet.
        const fresh = await fs.mkdtemp(
            path.join(os.tmpdir(), 'ernesto-archive-fresh-'),
        );
        try {
            const rel = await archiveRouteResult({
                workdir: fresh,
                uri: 'never-seen://my-route',
                params: {},
                runId: 'r-test-5',
                data: { fresh: true },
            });
            const abs = path.join(fresh, rel);
            await fs.access(abs);
        } finally {
            await fs.rm(fresh, { recursive: true, force: true });
        }
    });

    it('sanitizes a URI with unusual characters into a safe filename', async () => {
        const rel = await archiveRouteResult({
            workdir: WORKDIR,
            uri: 'app-logs://my/odd path?with=stuff',
            params: {},
            runId: 'r-test-6',
            data: {},
        });
        // No path separators or '?' in the basename.
        const basename = rel.split('/').pop()!;
        expect(basename).not.toMatch(/[?]/);
        // Path lives under the inferred workspace.
        expect(rel.startsWith('workspaces/app-logs/_results/')).toBe(true);
    });
});
