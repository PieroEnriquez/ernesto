import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { z } from 'zod';
import * as os from 'node:os';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { defineRoute, RouteRegistry, dispatchRoute } from '../../route';
import type { Workdir } from '../../workdir';
import { handleExecute } from '../../agent-verbs/execute';
import type { ExecuteVerbContext } from '../../agent-verbs/execute';

let WORKDIR_ROOT = '';

beforeAll(async () => {
    WORKDIR_ROOT = await fs.mkdtemp(
        path.join(os.tmpdir(), 'ernesto-archive-integration-'),
    );
});
afterAll(async () => {
    if (WORKDIR_ROOT) {
        await fs.rm(WORKDIR_ROOT, { recursive: true, force: true });
    }
});

function makeWorkdir(): Workdir {
    return {
        workdirId: 'wd-int',
        workingTreeRoot: WORKDIR_ROOT,
        branchRef: 'refs/workdirs/wd-int',
        fs: {} as any,
        master: { resolve: async () => ({ kind: 'not-found' }) },
        lock: async (fn: any) => fn(),
    } as Workdir;
}

function makeCtx(reg: RouteRegistry, workdir: Workdir): ExecuteVerbContext {
    const user = { id: 'u1', email: 'u1@example.com' };
    const scopes = new Set(['test:read']);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    return {
        user,
        scopes,
        log,
        dispatchByUri: async (uri, inputs) =>
            dispatchRoute(reg, uri, inputs, {
                user,
                scopes,
                workdirRoot: workdir.workingTreeRoot,
                log,
            } as Parameters<typeof dispatchRoute>[3]),
    };
}

const tabularRoute = defineRoute({
    uri: 'redshift://mock-rows',
    scope: 'test:read',
    input: z.object({}),
    output: z.object({
        rows: z.array(
            z.object({ method: z.string(), gross_usd: z.number() }),
        ),
    }),
    handler: async () => ({
        rows: Array.from({ length: 12 }, (_, i) => ({
            method: `m${i}`,
            gross_usd: 1000 + i * 100,
        })),
    }),
});

describe('execute → archive + preview', () => {
    it('attaches preview (compactified) and file (workdir-relative) to the result', async () => {
        const reg = new RouteRegistry();
        reg.register(tabularRoute);
        const wd = makeWorkdir();
        const result = await handleExecute(
            wd,
            reg,
            { uri: 'redshift://mock-rows', params: {} },
            makeCtx(reg, wd),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        // data is still the route's typed shape (no strip; no render manifest)
        expect((result.data as any).rows).toHaveLength(12);
        // preview is the compactified form
        const preview = (result as any).preview;
        expect(preview).toBeDefined();
        expect(preview.rows.total).toBe(12);
        expect(preview.rows.limit).toBe(5);
        expect(preview.rows.items).toHaveLength(5);
        // file points to an actual on-disk JSON
        const file = (result as any).file as string;
        expect(file.startsWith('workspaces/redshift/_results/')).toBe(true);
        const abs = path.join(WORKDIR_ROOT, file);
        const parsed = JSON.parse(await fs.readFile(abs, 'utf8'));
        expect(parsed.uri).toBe('redshift://mock-rows');
        expect(parsed.data.rows).toHaveLength(12);
    });

    it('respects previewLimit override', async () => {
        const reg = new RouteRegistry();
        reg.register(tabularRoute);
        const wd = makeWorkdir();
        const result = await handleExecute(
            wd,
            reg,
            { uri: 'redshift://mock-rows', params: {}, previewLimit: 2 },
            makeCtx(reg, wd),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const preview = (result as any).preview;
        expect(preview.rows.limit).toBe(2);
        expect(preview.rows.items).toHaveLength(2);
    });

    it('previewLimit: 0 suppresses the preview field but still archives', async () => {
        const reg = new RouteRegistry();
        reg.register(tabularRoute);
        const wd = makeWorkdir();
        const result = await handleExecute(
            wd,
            reg,
            { uri: 'redshift://mock-rows', params: {}, previewLimit: 0 },
            makeCtx(reg, wd),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect((result as any).preview).toBeUndefined();
        expect((result as any).file).toBeDefined();
    });

    it('previewLimit: "all" inlines the full data unchanged', async () => {
        const reg = new RouteRegistry();
        reg.register(tabularRoute);
        const wd = makeWorkdir();
        const result = await handleExecute(
            wd,
            reg,
            { uri: 'redshift://mock-rows', params: {}, previewLimit: 'all' },
            makeCtx(reg, wd),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const preview = (result as any).preview;
        // No wrapping when 'all' — raw shape.
        expect(preview.rows).toHaveLength(12);
    });

    it('honours a custom registry compactor', async () => {
        const reg = new RouteRegistry();
        reg.register(tabularRoute);
        reg.registerCompactor(tabularRoute.uri, (data, limit) => ({
            customLimit: limit,
            firstMethod: (data as any).rows[0]?.method,
        }));
        const wd = makeWorkdir();
        const result = await handleExecute(
            wd,
            reg,
            { uri: 'redshift://mock-rows', params: {} },
            makeCtx(reg, wd),
        );
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const preview = (result as any).preview as any;
        expect(preview.customLimit).toBe(5);
        expect(preview.firstMethod).toBe('m0');
    });
});
