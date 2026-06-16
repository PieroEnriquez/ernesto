/**
 * WorkbenchRef.paths normalization — the parse/convene boundary fix.
 *
 * CANONICAL FORM (decided + documented in parse.ts
 * `normalizeWorkbenchTreePath`): WORKSPACE-RELATIVE. A workbench path is
 * a tree path relative to its deepest declared workspace boundary, NOT a
 * full `workspaces/<…>/<leaf>/...` tree path. The lib `WorkbenchRef` doc
 * already says "workspace-relative tree paths"; the this-week demo
 * drifted to full-tree paths, so the parser normalizes BOTH the demo's
 * full-tree form AND already-relative authoring down to the one
 * canonical shape — every consumer (FE primaryPath, settle, diff) sees
 * one form.
 *
 * These tests pin: (a) full-tree → relative stripping, (b) idempotence
 * on already-relative paths, (c) `preview.path` normalized in lockstep
 * with `paths[]` (so `WorkbenchSurface`'s `preview.path ?? paths[0]`
 * stays coherent), (d) traversal / root / off-workspace paths are
 * REJECTED at parse time (the assert).
 */

import { describe, it, expect } from 'vitest';
import { parseWorkflowYaml } from '../parse';
import type { WorkbenchRef } from '../types';

/** Build a one-convene-step workflow carrying the given workbench block,
 *  parse it, and return the projected (normalized) workbench. */
function workbenchOf(workbenchYaml: string): WorkbenchRef {
    const yaml = `name: wb
description: workbench normalization fixture
version: 1
steps:
  approve:
    kind: convene
    room: "inbox:clement@bitrefill.com"
    title: T
    brief: B
    workbench:
${workbenchYaml}
`;
    const decl = parseWorkflowYaml(yaml, { filename: 'wb.yaml' });
    return (decl.steps.approve as { workbench: WorkbenchRef }).workbench;
}

describe('WorkbenchRef.paths normalization (canonical = workspace-relative)', () => {
    it('strips the full-tree workspaces/<…>/<leaf>/ prefix down to workspace-relative (the this-week demo fix)', () => {
        const wb = workbenchOf(`      workspaces: [sites, this-week]
      paths:
        - "workspaces/sites/this-week/data/latest.json"
        - "workspaces/sites/this-week/data/2026-W24.json"
      verb: approve
      previewKind: edition
      preview:
        site: this-week
        path: "workspaces/sites/this-week/data/latest.json"`);
        // paths AND preview.path are normalized in lockstep — the demo's
        // inconsistency (full-tree) collapses to the canonical form.
        expect(wb.paths).toEqual(['data/latest.json', 'data/2026-W24.json']);
        expect(wb.preview?.path).toBe('data/latest.json');
        // workspaces (parent..leaf leaf names) are untouched.
        expect(wb.workspaces).toEqual(['sites', 'this-week']);
    });

    it('is idempotent: already-workspace-relative paths pass through unchanged', () => {
        const wb = workbenchOf(`      workspaces: [sites, this-week]
      paths:
        - "data/latest.json"
      verb: approve
      preview:
        path: "data/latest.json"`);
        expect(wb.paths).toEqual(['data/latest.json']);
        expect(wb.preview?.path).toBe('data/latest.json');
    });

    it('normalizes a single-leaf workspace (no parent) — strips workspaces/<leaf>/', () => {
        const wb = workbenchOf(`      workspaces: [hr]
      paths:
        - "workspaces/hr/policies/leave.md"
      verb: settle`);
        expect(wb.paths).toEqual(['policies/leave.md']);
    });

    it('tolerates a leading slash and surrounding whitespace', () => {
        const wb = workbenchOf(`      workspaces: [sites, this-week]
      paths:
        - "/workspaces/sites/this-week/data/latest.json"
        - "  data/other.json  "
      verb: approve`);
        expect(wb.paths).toEqual(['data/latest.json', 'data/other.json']);
    });

    it('REJECTS a traversal segment at parse time (the consistency assert)', () => {
        expect(() =>
            workbenchOf(`      workspaces: [sites, this-week]
      paths:
        - "workspaces/sites/this-week/../escape.json"
      verb: approve`),
        ).toThrow(/must not contain '\.\.'/);
    });

    it('REJECTS a full-tree path that does not lie under the declared leaf', () => {
        expect(() =>
            workbenchOf(`      workspaces: [sites, this-week]
      paths:
        - "workspaces/other-site/data/latest.json"
      verb: approve`),
        ).toThrow(/does not lie under workspace "this-week"/);
    });

    it('REJECTS a path that resolves to the workspace root (no file)', () => {
        expect(() =>
            workbenchOf(`      workspaces: [sites, this-week]
      paths:
        - "workspaces/sites/this-week"
      verb: approve`),
        ).toThrow(/the workspace root, not a file/);
    });

    it('REJECTS an empty / whitespace-only path', () => {
        expect(() =>
            workbenchOf(`      workspaces: [sites, this-week]
      paths:
        - "   "
      verb: approve`),
        ).toThrow(/must be a non-empty/);
    });

    it('also normalizes preview.path when paths[] is absent (the lone preview-coordinate case)', () => {
        const wb = workbenchOf(`      workspaces: [sites, this-week]
      verb: approve
      previewKind: edition
      preview:
        site: this-week
        path: "workspaces/sites/this-week/data/latest.json"`);
        expect(wb.paths).toBeUndefined();
        expect(wb.preview?.path).toBe('data/latest.json');
    });
});
