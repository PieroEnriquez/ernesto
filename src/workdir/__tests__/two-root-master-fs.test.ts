/**
 * Tier-2 §4 — the TWO-ROOT `makeVolumeMasterFs(masterFsRoot, generatedRoot,
 * isGenerated, authoritative)`. Proves `ctx.master` (and every consumer — the
 * QA fragment-store etc.) resolves GENERATED paths gen-first from the sibling
 * store with master-FS fallback, while NON-generated paths and the single-arg
 * call resolve from master-FS exactly as before.
 *
 * The cutover `authoritative` flag controls whether a generated-store MISS falls
 * back to master-FS (OFF) or surfaces `not-found` (ON). Backward-safe by
 * construction: an empty store / `authoritative=false` behaves identically to
 * single-root master-FS, and a path the matcher classifies non-generated is
 * never even probed in the store.
 *
 * Real temp dirs; resolution returns the host-FS source path (`kind:'hardlink'`)
 * or `not-found`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { makeVolumeMasterFs } from '../node-adapters';

let root = '';
let masterFsRoot = '';
let generatedRoot = '';

// The backend passes this matcher (lib can't import backend volume-paths). It
// mirrors GENERATED_PATH_RE: extracted/, attached/, .derived-from-sha — but NOT
// attachments.yaml (a tracked git file), `_results` (ResultsStore-owned), or
// authored files.
const isGenerated = (rel: string) => /^workspaces\/(?:[^/]+\/)*(?:extracted\/.+|attached\/.+|\.derived-from-sha)$/.test(rel);

async function write(base: string, rel: string, content: string): Promise<void> {
    const abs = path.join(base, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
}

beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'two-root-mfs-'));
    masterFsRoot = path.join(root, 'master-fs');
    generatedRoot = path.join(root, 'generated');
    await mkdir(masterFsRoot, { recursive: true });
    await mkdir(generatedRoot, { recursive: true });
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const QA_FRAGMENT = 'workspaces/qa/compiled-steps/login.md'; // NOT generated
const EXTRACTED = 'workspaces/general/extracted/gh/pr-1.md'; // generated
const AUTHORED = 'workspaces/general/WORKSPACE.md'; // NOT generated

describe('single-arg makeVolumeMasterFs (backward-safe)', () => {
    it('resolves every path from master-FS, ignores any generated store', async () => {
        await write(masterFsRoot, EXTRACTED, 'M');
        const master = makeVolumeMasterFs(masterFsRoot);
        const r = await master.resolve(EXTRACTED);
        expect(r).toEqual({ kind: 'hardlink', sourcePath: path.join(masterFsRoot, EXTRACTED) });
        expect(await master.resolve('workspaces/general/missing.md')).toEqual({ kind: 'not-found' });
    });
});

describe('two-root: QA fragment (non-generated) → master-FS fallback', () => {
    it('resolves from master-FS regardless of the flag (qa/compiled-steps not generated)', async () => {
        await write(masterFsRoot, QA_FRAGMENT, 'STEP');
        for (const authoritative of [false, true]) {
            const master = makeVolumeMasterFs(masterFsRoot, generatedRoot, isGenerated, authoritative);
            const r = await master.resolve(QA_FRAGMENT);
            // The matcher never classifies it generated, so the store is not
            // probed; it resolves straight from master-FS — unchanged.
            expect(r).toEqual({ kind: 'hardlink', sourcePath: path.join(masterFsRoot, QA_FRAGMENT) });
        }
    });
});

describe('two-root: generated path resolves GEN-FIRST', () => {
    it('returns the generated-store sourcePath when present (store wins)', async () => {
        await write(masterFsRoot, EXTRACTED, 'OLD'); // in-flight migration leftover
        await write(generatedRoot, EXTRACTED, 'NEW');
        const master = makeVolumeMasterFs(masterFsRoot, generatedRoot, isGenerated, false);
        const r = await master.resolve(EXTRACTED);
        expect(r).toEqual({ kind: 'hardlink', sourcePath: path.join(generatedRoot, EXTRACTED) });
    });
});

describe('two-root flag OFF: generated MISS falls back to master-FS', () => {
    it('a legacy generated path only in master-FS still resolves (additive)', async () => {
        await write(masterFsRoot, EXTRACTED, 'LEGACY'); // store lacks it
        const master = makeVolumeMasterFs(masterFsRoot, generatedRoot, isGenerated, false);
        const r = await master.resolve(EXTRACTED);
        expect(r).toEqual({ kind: 'hardlink', sourcePath: path.join(masterFsRoot, EXTRACTED) });
    });

    it('empty store: every generated read falls back, observationally single-root', async () => {
        await write(masterFsRoot, EXTRACTED, 'X');
        await write(masterFsRoot, AUTHORED, 'WS');
        const oneRoot = makeVolumeMasterFs(masterFsRoot);
        const twoRoot = makeVolumeMasterFs(masterFsRoot, generatedRoot, isGenerated, false);
        for (const rel of [EXTRACTED, AUTHORED, 'workspaces/general/nope.md']) {
            expect(await twoRoot.resolve(rel)).toEqual(await oneRoot.resolve(rel));
        }
    });
});

describe('two-root flag ON (cutover): generated MISS → not-found (master-FS invisible)', () => {
    it('a generated path only in master-FS surfaces not-found (no fallback)', async () => {
        await write(masterFsRoot, EXTRACTED, 'LEGACY'); // store lacks it
        const master = makeVolumeMasterFs(masterFsRoot, generatedRoot, isGenerated, true);
        expect(await master.resolve(EXTRACTED)).toEqual({ kind: 'not-found' });
    });

    it('a generated path present in the store still resolves gen-first under the flag', async () => {
        await write(generatedRoot, EXTRACTED, 'NEW');
        const master = makeVolumeMasterFs(masterFsRoot, generatedRoot, isGenerated, true);
        expect(await master.resolve(EXTRACTED)).toEqual({
            kind: 'hardlink',
            sourcePath: path.join(generatedRoot, EXTRACTED),
        });
    });

    it('a NON-generated path still falls back to master-FS even under the flag', async () => {
        await write(masterFsRoot, AUTHORED, 'WS');
        const master = makeVolumeMasterFs(masterFsRoot, generatedRoot, isGenerated, true);
        expect(await master.resolve(AUTHORED)).toEqual({
            kind: 'hardlink',
            sourcePath: path.join(masterFsRoot, AUTHORED),
        });
    });
});
