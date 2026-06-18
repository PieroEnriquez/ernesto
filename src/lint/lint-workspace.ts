/**
 * Workspace settle gate.
 *
 * Enforces the invariants from `domains/workspaces/README.md` §3 (folder
 * shape), §12 (governance — read/write/admin scopes), §20 (lifecycle),
 * and §22 (settle gate).
 *
 * Rules:
 *
 *   out_of_scope_path             — every touched path lives under
 *                                   `workspaces/{w}/` for a declared `w`.
 *   workspace_md_missing          — every touched workspace has a
 *                                   `WORKSPACE.md` post-stage.
 *   missing_frontmatter           — modified `WORKSPACE.md` starts with a
 *      / invalid_frontmatter        valid YAML mapping that declares
 *                                   `name`, `description`, and `admin`.
 *   forbidden_workspace_name      — new workspaces match
 *                                   `^[a-z][a-z0-9-]{0,39}$`. Reserved
 *                                   `_`-prefix: only `_ernesto` allowed.
 *   forbidden_generated_path      — generated subdirectories
 *                                   (`extracted/`, `attached/`, `_results/`)
 *                                   and generated files (`.derived-from-sha`)
 *                                   under a workspace boundary are
 *                                   platform-owned; agents must not commit
 *                                   changes to them.
 *   forbidden_workspace_md_delete — `WORKSPACE.md` is the contract; never
 *                                   delete it.
 *   archived_workspace_edit       — workspaces with `archived: true` only
 *                                   accept the unarchive flip.
 *   file_too_large                — any file > 1 MiB → fail.
 *   binary_file                   — every committed file must be plain
 *                                   UTF-8 text; binaries are attached via
 *                                   `_ernesto://attach`, never committed.
 *   merge_markers                 — leftover git conflict markers from a
 *                                   stash pop or rebase.
 *   invalid_attachments_yaml      — a workspace's `attachments.yaml` must
 *                                   parse and pass the structural validation
 *                                   in `workspaces/attachments`. Deleting
 *                                   the file is allowed.
 *   invalid_nav_frontmatter       — a content file's navigation frontmatter
 *                                   has a wrong-typed `section` (must be a
 *                                   non-empty string), `order` (must be a
 *                                   number), or `title` (must be a string).
 *                                   These are the keys the workspace viewer's
 *                                   curated nav renders.
 *   unknown_section               — when a workspace's `WORKSPACE.md`
 *                                   frontmatter declares `sections:` (the
 *                                   ordered list of section names), a content
 *                                   file's `section` must be one of them.
 *   invalid_workspace_sections    — `sections:` in `WORKSPACE.md`, when
 *                                   present, must be an array of strings.
 *   read_denied                   — diff touches `workspaces/{w}/**` and
 *                                   the principal lacks `{w}`'s `read:`
 *                                   scope (default: everyone). `write:`,
 *                                   `admin:`, and `ernesto:agent-ops` all
 *                                   satisfy.
 *   write_denied                  — diff modifies prose (anything other
 *                                   than WORKSPACE.md frontmatter) without
 *                                   `write:`. `write:` defaults to
 *                                   `read:`. `admin:` and
 *                                   `ernesto:agent-ops` satisfy.
 *   admin_denied                  — diff modifies a system path
 *                                   (WORKSPACE.md frontmatter — change
 *                                   detected vs HEAD; new WORKSPACE.md
 *                                   creation; any change to read/write/
 *                                   admin) without `admin:` (or
 *                                   `ernesto:agent-ops`).
 *
 * Two surfaces:
 *   • `lintWorkspace` (default) — no principal info. Skips read/write/
 *     admin checks but enforces every shape and content rule, plus
 *     `merge_markers`.
 *   • `makeLintWorkspace(principal)` — closes over the principal's live
 *     scope set. Enforces every rule.
 */

import { readFile, stat } from 'fs/promises';
import { isUtf8 } from 'buffer';
import * as path from 'path';
import yaml from 'js-yaml';
import type { LintFn, LintError } from '../workdir/settle';
import { runGit } from '../workdir/run-git';
import { GENERATED_SUBDIRS, GENERATED_FILES } from '../workdir/settle-core';
import { validateAttachmentsYaml, ATTACHMENTS_YAML } from '../workspaces/attachments';
import {
    parseWorkspaceFrontmatter,
    canRead as canReadFm,
    canWrite as canWriteFm,
    canAdmin as canAdminFm,
    type WorkspaceFrontmatter,
} from '../workspaces/access';
import { parseWorkflowYaml, validateWorkflow, compileManagedAgentMdToWorkflow } from '../workflows';
import type { WorkflowValidateContext, WorkflowValidationError } from '../workflows';
import { parseManagedAgentMd } from '../managed-agents';
import { AGENT_OPS_SCOPE } from '../shared/scope';

/** Lint error key emitted when a `WORKSPACE.md` declares an `extractions:`
 *  entry whose `source` is not registered with the live extraction registry.
 *  Exported so other consumers (callers wiring `bypass`, integration tests,
 *  alerting) can reference the key without stringly-typed duplicates. */
export const UNREGISTERED_EXTRACTION_SOURCE = 'unregistered_extraction_source';

/** Lint error key emitted when a workspace's `attachments.yaml` fails the
 *  structural validation in `workspaces/attachments` (rule
 *  `invalid_attachments_yaml`). Exported so other consumers (callers wiring
 *  `bypass`, integration tests, alerting) can reference the key without
 *  stringly-typed duplicates. */
export const INVALID_ATTACHMENTS_YAML = 'invalid_attachments_yaml';

/** Lint error key emitted when a managed-agent `.md` declares a `trigger:`
 *  in frontmatter. A trigger is a *workflow* concept (`WorkflowTrigger`):
 *  the managed-agent compile path (`compileManagedAgentMdToWorkflow`) never
 *  projects it onto the compiled declaration, so the cron reconciler never
 *  sees it and the schedule silently never fires. The fix is a cron
 *  *workflow* (`trigger.cron`) whose agent step `ref`s the managed agent.
 *  Exported so callers/tests can reference the key without stringly-typed
 *  duplicates. */
export const TRIGGER_IGNORED_ON_MANAGED_AGENT = 'trigger_ignored_on_managed_agent';

const MAX_FILE_BYTES = 1024 * 1024;
const WORKSPACE_NAME_REGEX = /^[a-z][a-z0-9-]{0,39}$/;
const ERNESTO_WORKSPACE = '_ernesto';

/** Underscore-prefixed workspace names are reserved as system-only (rule
 *  `forbidden_workspace_name`). This Set is the allowlist of reserved names
 *  the platform does ship as real workspaces. Adding a name here is a
 *  spec-level decision — every entry is a system-owned workspace whose
 *  admin scope is `ernesto:workspace-admin`.
 *
 *  Exported so other layers (visibility, editor surface) treat the same
 *  set as system without duplicating the constant. */
export const RESERVED_SYSTEM_WORKSPACES: ReadonlySet<string> = new Set([ERNESTO_WORKSPACE, '_tmp', '_example', '_docs']);

// ─── Diff parser ──────────────────────────────────────────────────────────

interface DiffEntry {
    fromPath?: string;
    toPath?: string;
    /** Body of the modified file post-change (added lines), reconstructed
     *  from the diff. Only used by the archived-unarchive flip check. */
    addedHead: string;
    isDelete: boolean;
}

function parseDiff(diff: string): DiffEntry[] {
    const entries: DiffEntry[] = [];
    const lines = diff.split('\n');

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
        if (!header) {
            i++;
            continue;
        }

        let fromPath: string | undefined = header[1];
        let toPath: string | undefined = header[2];
        let isDelete = false;
        const addedLines: string[] = [];
        i++;

        while (i < lines.length && !lines[i].startsWith('diff --git ')) {
            const l = lines[i];
            if (l.startsWith('--- ')) {
                if (l === '--- /dev/null') fromPath = undefined;
                else {
                    const m = /^--- a\/(.+)$/.exec(l);
                    if (m) fromPath = m[1];
                }
            } else if (l.startsWith('+++ ')) {
                if (l === '+++ /dev/null') {
                    toPath = undefined;
                    isDelete = true;
                } else {
                    const m = /^\+\+\+ b\/(.+)$/.exec(l);
                    if (m) toPath = m[1];
                }
            } else if (l.startsWith('+') && !l.startsWith('+++')) {
                addedLines.push(l.slice(1));
            }
            i++;
        }

        entries.push({ fromPath, toPath, isDelete, addedHead: addedLines.join('\n') });
    }

    return entries;
}

// ─── Path classifiers ─────────────────────────────────────────────────────

/** Flat first-segment workspace name. Retained for the path-pattern rules
 *  (WORKSPACE.md create/delete) and the standalone `lintWorkflowFile`, which
 *  has no working-tree boundary scan. Depth-aware attribution — the rule that
 *  honours nested sub-workspaces — lives in `makeWorkspaceResolver`. In the
 *  flat layout the two agree (the only boundary is `workspaces/<name>/`). */
function workspaceOf(p: string): string | undefined {
    const m = /^workspaces\/([^/]+)(?:\/.*)?$/.exec(p);
    return m?.[1];
}

/** True iff `p` is a `WORKSPACE.md` at any depth under `workspaces/`. */
function isWsMdPath(p: string): boolean {
    return /^workspaces\/.+\/WORKSPACE\.md$/.test(p);
}

/** The workspace name a `WORKSPACE.md` path declares: the leaf of its parent
 *  dir (`workspaces/hr/recruiting/WORKSPACE.md` → `recruiting`). A workspace's
 *  identity is its leaf basename — globally unique, equal to its route scheme
 *  and scope prefix — never the full path (workspace-nesting design §"key
 *  insight"). */
function wsMdLeaf(p: string): string | undefined {
    const m = /^workspaces\/(.+)\/WORKSPACE\.md$/.exec(p);
    return m ? m[1].split('/').pop() : undefined;
}

/** A resolved workspace boundary: its leaf `name` and the `dir` that carries
 *  its `WORKSPACE.md`. For a flat workspace the two coincide
 *  (`{ name:'hr', dir:'workspaces/hr' }`); for a nested sub-workspace the dir
 *  records the location (`{ name:'recruiting', dir:'workspaces/hr/recruiting' }`). */
interface WsRef {
    name: string;
    dir: string;
}

/**
 * Depth-aware workspace attribution. A directory under `workspaces/` is a
 * boundary iff it contains a `WORKSPACE.md`; nesting is a *location* change,
 * not an identity change, so a path is attributed to the DEEPEST boundary
 * that encloses it:
 *
 *   workspaces/hr/recruiting/jobs/x.md
 *     → { name:'recruiting', dir:'workspaces/hr/recruiting' }
 *
 * when `workspaces/hr/recruiting/WORKSPACE.md` exists in the post-stage tree.
 * With no nested boundary (today's flat layout) the deepest boundary is
 * `workspaces/<seg>/`, so this is byte-identical to the old first-segment
 * rule. Non-`workspaces/` paths resolve to `undefined`. Boundary existence is
 * probed against the same working tree every other rule reads, memoized per
 * dir; per-path results are memoized too.
 */
function makeWorkspaceResolver(workingTreeRoot: string) {
    const dirIsBoundary = new Map<string, Promise<boolean>>();
    const cache = new Map<string, WsRef | undefined>();

    const probe = (dir: string): Promise<boolean> => {
        let hit = dirIsBoundary.get(dir);
        if (!hit) {
            hit = readFile(path.join(workingTreeRoot, dir, 'WORKSPACE.md'), 'utf8').then(
                () => true,
                () => false,
            );
            dirIsBoundary.set(dir, hit);
        }
        return hit;
    };

    return async (p: string): Promise<WsRef | undefined> => {
        if (cache.has(p)) return cache.get(p);
        const m = /^workspaces\/(.+)$/.exec(p);
        if (!m) {
            cache.set(p, undefined);
            return undefined;
        }
        const segs = m[1].split('/');
        let ref: WsRef | undefined;
        for (let depth = segs.length; depth >= 1 && !ref; depth--) {
            const dir = 'workspaces/' + segs.slice(0, depth).join('/');
            if (await probe(dir)) ref = { name: segs[depth - 1], dir };
        }
        // Flat fallback: no `WORKSPACE.md` ancestor on disk (a workspace being
        // created without its contract yet, or a malformed path). Attribute to
        // the first segment exactly as the pre-nesting rule did, so
        // `workspace_md_missing` / `out_of_scope_path` still fire as before.
        if (!ref) ref = { name: segs[0], dir: 'workspaces/' + segs[0] };
        cache.set(p, ref);
        return ref;
    };
}

/** Read the declared `sections:` order from a workspace's WORKSPACE.md
 *  frontmatter. Returns the validated list of section names, plus whether
 *  the field was present but malformed (so the caller can fire
 *  `invalid_workspace_sections` once). */
function readDeclaredSections(fm: Frontmatter | undefined): { present: boolean; valid: boolean; sections: readonly string[] } {
    const raw = fm?.sections;
    if (raw === undefined) return { present: false, valid: true, sections: [] };
    if (!Array.isArray(raw) || raw.some((s) => typeof s !== 'string')) {
        return { present: true, valid: false, sections: [] };
    }
    return { present: true, valid: true, sections: raw as string[] };
}

// ─── Frontmatter ──────────────────────────────────────────────────────────

interface Frontmatter {
    name?: unknown;
    description?: unknown;
    read?: unknown;
    write?: unknown;
    admin?: unknown;
    archived?: unknown;
    tags?: unknown;
    /** WORKSPACE.md only: ordered list of section names for curated nav. */
    sections?: unknown;
    /** Content files only: nav frontmatter the viewer renders. */
    section?: unknown;
    order?: unknown;
    title?: unknown;
    [k: string]: unknown;
}

interface FrontmatterParse {
    ok: true;
    data: Frontmatter;
}
interface FrontmatterMissing {
    ok: false;
    reason: 'missing';
}
interface FrontmatterInvalid {
    ok: false;
    reason: 'invalid';
    detail: string;
}
type FrontmatterResult = FrontmatterParse | FrontmatterMissing | FrontmatterInvalid;

function parseFrontmatter(body: string): FrontmatterResult {
    const trimmed = body.replace(/^\uFEFF/, '');
    const startMatch = /^---\s*\n/.exec(trimmed);
    if (!startMatch) return { ok: false, reason: 'missing' };

    const rest = trimmed.slice(startMatch[0].length);
    const endMatch = /\n---\s*(?:\n|$)/.exec(rest);
    if (!endMatch) return { ok: false, reason: 'invalid', detail: 'unterminated frontmatter block' };
    const yamlBody = rest.slice(0, endMatch.index);

    let parsed: unknown;
    try {
        parsed = yaml.load(yamlBody);
    } catch (err) {
        return { ok: false, reason: 'invalid', detail: (err as Error).message };
    }
    if (parsed === null || parsed === undefined) {
        return { ok: false, reason: 'invalid', detail: 'frontmatter is empty' };
    }
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, reason: 'invalid', detail: 'frontmatter must be a YAML mapping' };
    }
    return { ok: true, data: parsed as Frontmatter };
}

async function readWorkspaceMdFromDisk(workingTreeRoot: string, wsDir: string): Promise<{ exists: boolean; frontmatter?: Frontmatter }> {
    const file = path.join(workingTreeRoot, wsDir, 'WORKSPACE.md');
    try {
        const body = await readFile(file, 'utf8');
        const fm = parseFrontmatter(body);
        return { exists: true, frontmatter: fm.ok ? fm.data : undefined };
    } catch {
        return { exists: false };
    }
}

/**
 * Read the pre-stage `WORKSPACE.md` from `git show HEAD:...`. Returns
 * `{ exists: false }` if the file didn't exist at HEAD (workspace is
 * being created in this commit) or if git isn't available (test fixture
 * without a repo — falls back to "treat as new", which gates harder).
 */
async function readOldFrontmatter(workingTreeRoot: string, wsDir: string): Promise<{ exists: boolean; frontmatter?: Frontmatter }> {
    try {
        const content = await runGit(workingTreeRoot, ['show', `HEAD:${wsDir}/WORKSPACE.md`]);
        const fm = parseFrontmatter(content);
        return { exists: true, frontmatter: fm.ok ? fm.data : undefined };
    } catch {
        return { exists: false };
    }
}

// ─── Conflict markers ─────────────────────────────────────────────────────

function hasConflictMarkers(content: string): boolean {
    const lines = content.split('\n');
    let sawOpen = false;
    let sawSep = false;
    for (const line of lines) {
        if (/^<{7}(\s|$)/.test(line)) sawOpen = true;
        else if (sawOpen && /^={7}$/.test(line)) sawSep = true;
        else if (sawSep && /^>{7}(\s|$)/.test(line)) return true;
    }
    return false;
}

// ─── Scopes ───────────────────────────────────────────────────────────────

export interface LintPrincipal {
    /** Live scope set, resolved at request time by the deployer. */
    scopes: ReadonlySet<string>;
    /** Email — kept for audit-log purposes; not used in scope resolution. */
    email?: string;
}

function asStr(v: unknown): string | undefined {
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function readScopeOf(fm: Frontmatter): string | undefined {
    return asStr(fm.read);
}
function writeScopeOf(fm: Frontmatter): string | undefined {
    return asStr(fm.write);
}
function adminScopeOf(fm: Frontmatter): string | undefined {
    return asStr(fm.admin);
}

function hasAgentOps(p: LintPrincipal | undefined): boolean {
    return !!p && p.scopes.has(AGENT_OPS_SCOPE);
}

/** Project the lint's loose `Frontmatter` onto the canonical access shape: the
 *  access model decides purely from `read`/`write`/`admin` (string scopes). */
function accessFm(fm: Frontmatter): WorkspaceFrontmatter {
    return { read: asStr(fm.read), write: asStr(fm.write), admin: asStr(fm.admin) };
}

/** Read access. Default (no `read:`): everyone. `write`/`admin` satisfy; the
 *  agent-ops bypass is decided here, the rest by the canonical access model. */
function canRead(fm: Frontmatter, p: LintPrincipal | undefined): boolean {
    if (hasAgentOps(p)) return true;
    if (!p) return canReadFm(accessFm(fm), new Set());
    return canReadFm(accessFm(fm), p.scopes);
}

/** Write access. Default: same as read. `admin` satisfies; agent-ops bypass. */
function canWrite(fm: Frontmatter, p: LintPrincipal | undefined): boolean {
    if (hasAgentOps(p)) return true;
    if (!p) return canWriteFm(accessFm(fm), new Set());
    return canWriteFm(accessFm(fm), p.scopes);
}

/** Admin access. No default — `admin:` is required. agent-ops bypass. */
function canAdmin(fm: Frontmatter, p: LintPrincipal | undefined): boolean {
    if (hasAgentOps(p)) return true;
    if (!p) return canAdminFm(accessFm(fm), new Set());
    return canAdminFm(accessFm(fm), p.scopes);
}

/** Compare two frontmatter objects after canonicalizing key order. */
function frontmatterDiffers(a: Frontmatter | undefined, b: Frontmatter | undefined): boolean {
    return JSON.stringify(canonicalize(a ?? {})) !== JSON.stringify(canonicalize(b ?? {}));
}

function canonicalize(o: unknown): unknown {
    if (o === null || typeof o !== 'object') return o;
    if (Array.isArray(o)) return o.map(canonicalize);
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(o as Record<string, unknown>).sort()) {
        sorted[k] = canonicalize((o as Record<string, unknown>)[k]);
    }
    return sorted;
}

// ─── Main lint function ───────────────────────────────────────────────────

interface BuildOptions {
    /** When provided, enforces read/write/admin checks. When omitted, the
     *  lint runs in scope-less mode: those rules are skipped but every
     *  shape/content rule still runs. */
    principal?: LintPrincipal;
    /** Rule codes to skip. Wired by privileged callers that legitimately
     *  emit diffs the rule would otherwise reject (e.g. the derive worker's
     *  `forbidden_generated_path` bypass). User-initiated settles must
     *  never set this. */
    bypass?: ReadonlySet<string>;
    /** Resolver for the set of currently registered extraction sources.
     *  When provided, modified `WORKSPACE.md` files whose `extractions:`
     *  block names an unregistered source fail with
     *  `unregistered_extraction_source`. When omitted, the check is skipped
     *  entirely — callers without an extraction registry on hand (eg. the
     *  default scope-less preview) opt out, but production callers MUST
     *  wire this. Resolved at call time so plugin registration races don't
     *  bake a stale snapshot. */
    getRegisteredSources?: () => ReadonlySet<string>;
}

function build({ principal, bypass, getRegisteredSources }: BuildOptions): LintFn {
    const isBypassed = (code: string): boolean => bypass?.has(code) ?? false;
    return async ({ diff, workspaces, workingTreeRoot }) => {
        const errors: LintError[] = [];
        const entries = parseDiff(diff);
        const declared = new Set(workspaces);

        const touchedPaths = new Set<string>();
        for (const e of entries) {
            if (e.fromPath) touchedPaths.add(e.fromPath);
            if (e.toPath) touchedPaths.add(e.toPath);
        }

        // Resolve every touched path to its (possibly nested) workspace
        // boundary once, against the post-stage working tree. All attribution
        // below keys on `refOf` so a nested sub-workspace's files are charged
        // to the sub-workspace (leaf name), not its enclosing parent.
        const resolveWs = makeWorkspaceResolver(workingTreeRoot);
        const refByPath = new Map<string, WsRef | undefined>();
        for (const p of touchedPaths) refByPath.set(p, await resolveWs(p));
        const refOf = (p: string): WsRef | undefined => {
            if (refByPath.has(p)) return refByPath.get(p);
            const w = workspaceOf(p);
            return w ? { name: w, dir: `workspaces/${w}` } : undefined;
        };

        // Depth-aware path classifiers (relative to the resolved boundary).
        const isWsMd = (p: string): boolean => {
            const r = refOf(p);
            return !!r && p === `${r.dir}/WORKSPACE.md`;
        };
        const relToBoundary = (p: string): string => {
            const r = refOf(p);
            if (!r) return p;
            if (p === r.dir) return '';
            return p.startsWith(r.dir + '/') ? p.slice(r.dir.length + 1) : p;
        };
        // Generated subdirs sit directly under a boundary — at any depth,
        // relative to that boundary. Generated files match by basename. Both
        // lists are the settle staging excludes (settle-core); the lint and
        // the stage pathspecs stay in sync by importing the same constants.
        const isGenerated = (p: string): boolean => {
            const rel = relToBoundary(p);
            if ((GENERATED_SUBDIRS as readonly string[]).some((s) => rel === s || rel.startsWith(s + '/'))) return true;
            return (GENERATED_FILES as readonly string[]).includes(path.posix.basename(rel));
        };
        // A markdown content file the viewer renders in its curated nav: any
        // `.md`/`.mdx` under the resolved workspace that is NOT the WORKSPACE.md
        // contract and NOT a generated mirror.
        const isContentMd = (p: string, w: string): boolean => {
            if (refOf(p)?.name !== w) return false;
            if (isWsMd(p)) return false;
            if (isGenerated(p)) return false;
            return /\.mdx?$/.test(p);
        };

        // out_of_scope_path — a touched path is in scope iff its resolved
        // boundary's leaf name is one the settle declared. Nesting is location,
        // not identity: `workspaces/hr/recruiting/x` resolves to `recruiting`,
        // so declaring `recruiting` (alone) admits it.
        for (const p of touchedPaths) {
            const ref = refOf(p);
            if (!ref || !declared.has(ref.name)) {
                errors.push({
                    code: 'out_of_scope_path',
                    path: p,
                    message: `Path ${p} is not under any declared workspace: ${[...declared].join(', ') || '(none)'}`,
                });
            }
        }

        // forbidden_generated_path — generated subdirs are platform-owned
        // mirrors and generated files are derive-worker outputs; neither may
        // enter the git index. The lib's settleFromWorktree already excludes
        // them via pathspec, but the lint catches any path that slipped past
        // (e.g. a settleFromPatch with a hand-crafted diff — `apply --index`
        // ignores .gitignore for new files).
        if (!isBypassed('forbidden_generated_path')) {
            for (const p of touchedPaths) {
                if (isGenerated(p)) {
                    errors.push({
                        code: 'forbidden_generated_path',
                        workspace: refOf(p)?.name,
                        path: p,
                        message: `Path ${p} is a generated path (${GENERATED_SUBDIRS.map((s) => `${s}/`).join(', ')} or ${GENERATED_FILES.join(', ')}) and cannot be edited by hand`,
                    });
                }
            }
        }

        // forbidden_workspace_md_delete — detect by path pattern, not by a
        // boundary probe: the file is gone from the post-stage tree, so it is
        // no longer a discoverable boundary. The deleted contract names the
        // workspace by its leaf (depth-proof).
        //
        // RELOCATION CARVE-OUT: a delete is allowed when the SAME workspace (by
        // leaf name) is (re)created elsewhere in this patch — i.e. a move
        // (`workspaces/cs-scheduler/WORKSPACE.md` → `workspaces/cs/cs-scheduler/WORKSPACE.md`,
        // leaf `cs-scheduler`). Only an ORPHANING delete (no matching re-create)
        // is still forbidden, so the workspace contract is never silently lost.
        const recreatedWsLeaves = new Set<string>();
        for (const e of entries) {
            if (e.fromPath !== undefined) continue; // adds have no fromPath
            if (!e.toPath || !isWsMdPath(e.toPath)) continue;
            const leaf = wsMdLeaf(e.toPath);
            if (leaf) recreatedWsLeaves.add(leaf);
        }
        for (const e of entries) {
            if (!e.isDelete) continue;
            const p = e.fromPath;
            if (!p || !isWsMdPath(p)) continue;
            const w = wsMdLeaf(p);
            if (w && recreatedWsLeaves.has(w)) continue; // relocation: re-created elsewhere
            errors.push({
                code: 'forbidden_workspace_md_delete',
                workspace: w,
                path: p,
                message: `WORKSPACE.md for workspace '${w}' was deleted without being re-created elsewhere; this file is the workspace's contract`,
            });
        }

        // forbidden_workspace_name (new workspace creation only). Keys on the
        // leaf of the new WORKSPACE.md's parent dir — a nested sub-workspace
        // is named/validated by its leaf (`hr/recruiting` → `recruiting`).
        for (const e of entries) {
            if (e.fromPath !== undefined) continue;
            if (!e.toPath || !isWsMdPath(e.toPath)) continue;
            const w = wsMdLeaf(e.toPath);
            if (!w) continue;
            if (RESERVED_SYSTEM_WORKSPACES.has(w)) continue;
            if (w.startsWith('_')) {
                errors.push({
                    code: 'forbidden_workspace_name',
                    workspace: w,
                    path: e.toPath,
                    message: `Workspace name '${w}' is reserved (underscore-prefixed names are system-only)`,
                });
            } else if (!WORKSPACE_NAME_REGEX.test(w)) {
                errors.push({
                    code: 'forbidden_workspace_name',
                    workspace: w,
                    path: e.toPath,
                    message: `Workspace name '${w}' must match ${WORKSPACE_NAME_REGEX}`,
                });
            }
        }

        // missing_frontmatter / invalid_frontmatter — reads post-stage from
        // disk. Keyed on the touched WORKSPACE.md PATH (so a nested
        // `hr/recruiting/WORKSPACE.md` is read at its real location); the
        // workspace's `name` must equal its LEAF segment (`recruiting`), not
        // the full path — that is the nested-name check the design calls for.
        const touchedWorkspaceMds = new Set<string>();
        for (const e of entries) {
            const target = e.toPath;
            if (!target || !isWsMdPath(target)) continue;
            touchedWorkspaceMds.add(target);
        }
        for (const target of touchedWorkspaceMds) {
            const w = wsMdLeaf(target)!; // identity = leaf segment
            let fileBody: string;
            try {
                fileBody = await readFile(path.join(workingTreeRoot, target), 'utf8');
            } catch {
                continue;
            }
            const fm = parseFrontmatter(fileBody);
            if (!fm.ok && fm.reason === 'missing') {
                errors.push({
                    code: 'missing_frontmatter',
                    workspace: w,
                    path: target,
                    message: `WORKSPACE.md for '${w}' is missing YAML frontmatter (must start with '---')`,
                });
                continue;
            }
            if (!fm.ok && fm.reason === 'invalid') {
                errors.push({
                    code: 'invalid_frontmatter',
                    workspace: w,
                    path: target,
                    message: `WORKSPACE.md for '${w}' has invalid frontmatter: ${fm.detail}`,
                });
                continue;
            }
            const data = fm.data;
            if (typeof data.name !== 'string' || data.name.trim() === '') {
                errors.push({
                    code: 'invalid_frontmatter',
                    workspace: w,
                    path: target,
                    message: `WORKSPACE.md for '${w}' frontmatter must declare a non-empty 'name'`,
                });
            } else if (data.name !== w) {
                errors.push({
                    code: 'invalid_frontmatter',
                    workspace: w,
                    path: target,
                    message: `WORKSPACE.md frontmatter 'name: ${data.name}' does not match directory name '${w}'`,
                });
            }
            if (typeof data.description !== 'string' || data.description.trim() === '') {
                errors.push({
                    code: 'invalid_frontmatter',
                    workspace: w,
                    path: target,
                    message: `WORKSPACE.md for '${w}' frontmatter must declare a non-empty 'description'`,
                });
            }
            if (typeof data.admin !== 'string' || data.admin.trim() === '') {
                errors.push({
                    code: 'invalid_frontmatter',
                    workspace: w,
                    path: target,
                    message: `WORKSPACE.md for '${w}' frontmatter must declare a non-empty 'admin' scope (required field)`,
                });
            }

            // invalid_workspace_sections — `sections:`, when present, must be
            // an array of strings (the curated-nav section order the viewer
            // renders). A wrong shape can't be projected to a section list.
            const declaredSections = readDeclaredSections(data);
            if (declaredSections.present && !declaredSections.valid) {
                errors.push({
                    code: 'invalid_workspace_sections',
                    workspace: w,
                    path: target,
                    message: `WORKSPACE.md for '${w}' frontmatter 'sections' must be an array of strings`,
                });
            }

            // unregistered_extraction_source — gated on caller wiring a
            // registry resolver. Bypassable for privileged route shims that
            // legitimately mutate WORKSPACE.md frontmatter outside the
            // declared-extractions invariant (none today, but the bypass
            // matches the rest of the lint surface for symmetry).
            if (getRegisteredSources && !isBypassed(UNREGISTERED_EXTRACTION_SOURCE)) {
                const registered = getRegisteredSources();
                const extractions = data.extractions;
                if (Array.isArray(extractions)) {
                    for (const entry of extractions) {
                        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
                        const source = (entry as Record<string, unknown>).source;
                        if (typeof source !== 'string' || source.trim() === '') continue;
                        if (!registered.has(source)) {
                            errors.push({
                                code: UNREGISTERED_EXTRACTION_SOURCE,
                                workspace: w,
                                path: target,
                                message: `WORKSPACE.md for '${w}' declares extraction source '${source}', which is not in the registered set [${[...registered].sort().join(', ')}]`,
                            });
                        }
                    }
                }
            }
        }

        // workflow_* (lints workflow YAML and managed-agent .md sources)
        // Runs before the file_too_large pass to surface workflow errors
        // even on files large enough to fail that rule too.
        for (const e of entries) {
            if (e.isDelete) continue;
            const p = e.toPath;
            if (!p) continue;
            if (!isWorkflowPath(p)) continue;
            try {
                const abs = path.join(workingTreeRoot, p);
                const text = await readFile(abs, 'utf8');
                const wfErrors = await lintWorkflowFile(p, text, {
                    filename: p,
                });
                for (const we of wfErrors) errors.push(we);
            } catch {
                // best-effort
            }
        }

        // trigger_ignored_on_managed_agent — a managed-agent `.md` cannot
        // carry a cron. `compileManagedAgentMdToWorkflow` never projects
        // `trigger:`, so the reconciler never registers it and the schedule
        // silently never fires. Surface it as an authoring error; the fix is
        // a cron workflow (`trigger.cron`) whose agent step `ref`s the agent.
        for (const e of entries) {
            if (e.isDelete) continue;
            const p = e.toPath;
            if (!p) continue;
            if (!isManagedAgentPath(p)) continue;
            try {
                const abs = path.join(workingTreeRoot, p);
                const text = await readFile(abs, 'utf8');
                const md = parseManagedAgentMd(text, {
                    slug: p.replace(/^.*\//, '').replace(/\.md$/, ''),
                    workspace: refOf(p)?.name ?? '',
                });
                const triggerErr = managedAgentTriggerError(md.frontMatter, p, refOf(p)?.name);
                if (triggerErr) errors.push(triggerErr);
            } catch {
                // best-effort: unrelated parse concerns are out of scope here.
            }
        }

        // invalid_attachments_yaml — a workspace's attachments index must
        // parse and validate structurally (workspaces/attachments is the one
        // schema every reader/writer shares). Reads post-stage from disk,
        // nesting-aware. Deleting the file is allowed — a workspace may drop
        // its index (the GC sweep reclaims the bytes after grace).
        for (const e of entries) {
            if (e.isDelete) continue;
            const p = e.toPath;
            if (!p) continue;
            if (relToBoundary(p) !== ATTACHMENTS_YAML) continue;
            try {
                const text = await readFile(path.join(workingTreeRoot, p), 'utf8');
                for (const ae of lintAttachmentsFile(p, text)) {
                    errors.push({ ...ae, workspace: refOf(p)?.name });
                }
            } catch {
                // best-effort
            }
        }

        // file_too_large + binary_file + merge_markers (one read per file)
        for (const e of entries) {
            if (e.isDelete) continue;
            const p = e.toPath;
            if (!p) continue;
            try {
                const abs = path.join(workingTreeRoot, p);
                const st = await stat(abs);
                if (!st.isFile()) continue;
                if (st.size > MAX_FILE_BYTES) {
                    errors.push({
                        code: 'file_too_large',
                        path: p,
                        workspace: refOf(p)?.name,
                        message: `File ${p} is ${st.size} bytes; max allowed is ${MAX_FILE_BYTES}`,
                    });
                    continue;
                }
                const buf = await readFile(abs);
                // The explicit NUL check is required: NUL is valid UTF-8, so
                // `isUtf8` alone would wave through most real binaries.
                if (buf.includes(0) || !isUtf8(buf)) {
                    errors.push({
                        code: 'binary_file',
                        path: p,
                        workspace: refOf(p)?.name,
                        message: `File ${p} is not plain UTF-8 text; binaries must be attached via _ernesto://attach, never committed`,
                    });
                    continue;
                }
                if (hasConflictMarkers(buf.toString('utf8'))) {
                    errors.push({
                        code: 'merge_markers',
                        path: p,
                        workspace: refOf(p)?.name,
                        message: `File ${p} contains unresolved git conflict markers; resolve them before settling`,
                    });
                }
            } catch {
                // best-effort
            }
        }

        // Navigation frontmatter pass — content files only. Shape-checks the
        // `section`/`order`/`title` keys the workspace viewer's curated nav
        // renders, and (when the workspace's WORKSPACE.md declares an ordered
        // `sections:` list) enforces that each file's `section` is one of
        // them. Reads post-stage frontmatter from disk; deletes are skipped.
        const declaredSectionsCache = new Map<string, ReadonlySet<string>>();
        const getDeclaredSections = async (wsDir: string): Promise<ReadonlySet<string> | undefined> => {
            if (declaredSectionsCache.has(wsDir)) return declaredSectionsCache.get(wsDir);
            const ws = await readWorkspaceMdFromDisk(workingTreeRoot, wsDir);
            const decl = readDeclaredSections(ws.frontmatter);
            const set = decl.present && decl.valid ? new Set(decl.sections) : undefined;
            declaredSectionsCache.set(wsDir, set as ReadonlySet<string>);
            return set;
        };

        for (const e of entries) {
            if (e.isDelete) continue;
            const p = e.toPath;
            if (!p) continue;
            const ref = refOf(p);
            if (!ref || !declared.has(ref.name) || !isContentMd(p, ref.name)) continue;
            const w = ref.name;

            let body: string;
            try {
                body = await readFile(path.join(workingTreeRoot, p), 'utf8');
            } catch {
                continue; // best-effort
            }
            const fm = parseFrontmatter(body);
            // No frontmatter (or malformed) on a content file is fine here —
            // nav keys are all optional. Only validate when we have a mapping.
            if (!fm.ok) continue;
            const data = fm.data;

            if (data.section !== undefined && (typeof data.section !== 'string' || data.section.trim() === '')) {
                errors.push({
                    code: 'invalid_nav_frontmatter',
                    workspace: w,
                    path: p,
                    message: `File ${p} frontmatter 'section' must be a non-empty string`,
                });
            }
            if (data.order !== undefined && (typeof data.order !== 'number' || Number.isNaN(data.order))) {
                errors.push({
                    code: 'invalid_nav_frontmatter',
                    workspace: w,
                    path: p,
                    message: `File ${p} frontmatter 'order' must be a number`,
                });
            }
            if (data.title !== undefined && typeof data.title !== 'string') {
                errors.push({
                    code: 'invalid_nav_frontmatter',
                    workspace: w,
                    path: p,
                    message: `File ${p} frontmatter 'title' must be a string`,
                });
            }

            // unknown_section — only when `section` is a usable string AND the
            // workspace declares a `sections:` list. A wrong-typed declared
            // list (invalid_workspace_sections above) yields no set, so this
            // check is skipped rather than firing spurious unknowns.
            if (typeof data.section === 'string' && data.section.trim() !== '') {
                const allowed = await getDeclaredSections(ref.dir);
                if (allowed && !allowed.has(data.section)) {
                    errors.push({
                        code: 'unknown_section',
                        workspace: w,
                        path: p,
                        message: `File ${p} declares section '${data.section}', which is not in WORKSPACE.md's declared sections [${[...allowed].join(', ')}]`,
                    });
                }
            }
        }

        // Per-workspace pass: workspace_md_missing, archived_workspace_edit,
        // and the read/write/admin scope rules. Keyed on the resolved boundary
        // so a nested sub-workspace is its own unit (its own WORKSPACE.md,
        // scope, archive/project rules), read at its real `dir`.
        const touchedWsDirs = new Map<string, string>(); // leaf name -> boundary dir
        for (const p of touchedPaths) {
            const ref = refOf(p);
            if (ref && declared.has(ref.name)) touchedWsDirs.set(ref.name, ref.dir);
        }

        for (const [w, wsDir] of touchedWsDirs) {
            const ws = await readWorkspaceMdFromDisk(workingTreeRoot, wsDir);

            // workspace_md_missing
            if (!ws.exists) {
                errors.push({
                    code: 'workspace_md_missing',
                    workspace: w,
                    message: `Workspace '${w}' has no WORKSPACE.md; create one before editing other files in it`,
                });
                continue;
            }

            const fm = ws.frontmatter ?? {};
            const oldFmRead = await readOldFrontmatter(workingTreeRoot, wsDir);

            // archived_workspace_edit — a workspace that was ALREADY archived
            // at HEAD is frozen: only the unarchive flip (archived:false,
            // WORKSPACE.md-only) may touch it. Gate on the pre-diff (HEAD)
            // state — mirroring the scope rules below — NOT the post-patch
            // working tree. The working tree shows `archived: true` for a
            // *fresh* archive too, so reading it here made the archive
            // transition itself unreachable (you could only ever unarchive).
            const wasArchived = oldFmRead.exists && oldFmRead.frontmatter?.archived === true;
            if (wasArchived) {
                const touchedInWs = [...touchedPaths].filter((p) => refOf(p)?.name === w);
                const onlyWorkspaceMd = touchedInWs.every((p) => isWsMd(p));
                const unarchives = onlyWorkspaceMd && fm.archived === false;
                if (!unarchives) {
                    errors.push({
                        code: 'archived_workspace_edit',
                        workspace: w,
                        message: `Workspace '${w}' is archived; only the unarchive flip ('archived: false' in WORKSPACE.md) is allowed`,
                    });
                }
            }

            // project_md_missing — a `projects/<name>/` folder is a sub-workspace:
            // it must carry a PROJECT.md landing (its source-of-truth contract,
            // like WORKSPACE.md for the workspace). Only fires for projects this
            // diff actually touches, so non-adopting workspaces are unaffected.
            const projPrefix = `${wsDir}/projects/`;
            const touchedProjects = new Set<string>();
            for (const p of touchedPaths) {
                if (!p.startsWith(projPrefix)) continue;
                const rest = p.slice(projPrefix.length);
                const slash = rest.indexOf('/');
                if (slash > 0) touchedProjects.add(rest.slice(0, slash)); // inside projects/<name>/…
            }
            for (const proj of touchedProjects) {
                const pmd = path.join(workingTreeRoot, wsDir, 'projects', proj, 'PROJECT.md');
                const exists = await readFile(pmd, 'utf8')
                    .then(() => true)
                    .catch(() => false);
                if (!exists) {
                    errors.push({
                        code: 'project_md_missing',
                        workspace: w,
                        message: `Project '${w}/projects/${proj}' has no PROJECT.md; add the project's source-of-truth landing before adding other files`,
                    });
                }
            }

            // Scope rules — skipped in scope-less mode.
            if (!principal) continue;

            // read_denied — any touch requires read access.
            if (!canRead(fm, principal)) {
                errors.push({
                    code: 'read_denied',
                    workspace: w,
                    message: `Workspace '${w}' read scope '${readScopeOf(fm) ?? '(everyone)'}' is not satisfied by principal scopes`,
                });
                continue; // can't reason about per-file rules without read
            }

            // Per-file write_denied / admin_denied. (`oldFmRead` computed above.)
            const wsEntries = entries.filter((e) => {
                const t = e.toPath ?? e.fromPath;
                return t !== undefined && refOf(t)?.name === w;
            });

            for (const e of wsEntries) {
                const target = e.toPath ?? e.fromPath!;

                // WORKSPACE.md edits: frontmatter changed → admin; body-only → write.
                if (isWsMd(target) && !e.isDelete) {
                    const isNewWs = !oldFmRead.exists;
                    const fmChanged = isNewWs || frontmatterDiffers(oldFmRead.frontmatter, fm);
                    if (fmChanged) {
                        // For new workspaces, the principal must hold the
                        // scope they're declaring (can't lock others out
                        // without already being authorized). For edits, the
                        // *previous* admin scope gates the change — current
                        // admin must approve the update.
                        const adminFm = isNewWs ? fm : (oldFmRead.frontmatter ?? {});
                        if (!canAdmin(adminFm, principal)) {
                            errors.push({
                                code: 'admin_denied',
                                workspace: w,
                                path: target,
                                message: isNewWs
                                    ? `Creating workspace '${w}' requires holding its declared admin scope '${adminScopeOf(fm) ?? '(missing — invalid frontmatter)'}'`
                                    : `Changing WORKSPACE.md frontmatter for '${w}' requires the workspace's admin scope '${adminScopeOf(adminFm) ?? '(none)'}'`,
                            });
                        }
                    } else if (!canWrite(fm, principal)) {
                        errors.push({
                            code: 'write_denied',
                            workspace: w,
                            path: target,
                            message: `Editing WORKSPACE.md body for '${w}' requires write scope '${writeScopeOf(fm) ?? readScopeOf(fm) ?? '(everyone)'}'`,
                        });
                    }
                    continue;
                }

                // Prose (any non-system file): write-level. Includes deletes.
                if (!canWrite(fm, principal)) {
                    errors.push({
                        code: 'write_denied',
                        workspace: w,
                        path: target,
                        message: `Editing prose in '${w}' requires write scope '${writeScopeOf(fm) ?? readScopeOf(fm) ?? '(everyone)'}'`,
                    });
                }
            }
        }

        return errors.length === 0 ? { ok: true } : { ok: false, errors };
    };
}

/**
 * Default scope-less lint. Enforces every rule that does not depend on the
 * principal (shape, content, merge_markers). Suitable
 * for non-authoritative previews; the authoritative path always uses
 * `makeLintWorkspace(principal)`.
 *
 * Skips `unregistered_extraction_source` because no registry is wired —
 * authoritative callers must use `makeLintWorkspace` with
 * `getRegisteredSources` set.
 *
 * QUARANTINE: every authoritative (settle) AND editor-preview path MUST
 * construct lint via the backend `buildSettleLint(principal)` factory, which
 * binds the principal and always wires `getRegisteredSources` from the live
 * extraction registry — so editor-lint === settle-lint by construction. This
 * scope-less export is reserved for genuinely non-principal contexts only
 * (worker dashboards-e2e, spec-conformance invariants that assert
 * principal-independent rules). Do NOT reach for it on a settle or preview
 * path: doing so silently drops `unregistered_extraction_source` and the
 * scope checks, re-opening the very parity gap `buildSettleLint` closes.
 */
export const lintWorkspace: LintFn = build({});

export interface MakeLintWorkspaceOptions {
    /** Rule codes the caller is privileged to skip. Wire only from
     *  privileged callers that legitimately emit diffs the rule would
     *  otherwise reject (e.g. derive-worker settles that need to bypass
     *  `forbidden_generated_path`). User-initiated settles must not
     *  pass this. */
    bypass?: ReadonlySet<string>;
    /** Live extraction registry resolver. When set, modified `WORKSPACE.md`
     *  files whose `extractions:` block names an unknown source fail with
     *  `unregistered_extraction_source`. Resolve at call time so plugin
     *  registration races don't bake a stale snapshot. */
    getRegisteredSources?: () => ReadonlySet<string>;
}

/** Build a lint function bound to the principal's live scope set. */
export function makeLintWorkspace(principal: LintPrincipal, options: MakeLintWorkspaceOptions = {}): LintFn {
    return build({
        principal,
        bypass: options.bypass,
        getRegisteredSources: options.getRegisteredSources,
    });
}

// ─── Workflow file lint (settle-time hook) ──────────────────────────────

/**
 * Lint a single workflow file — either a `.yaml`/`.yml` workflow
 * declaration or a managed-agent `.md` shorthand. Returns the
 * collected `LintError[]` (empty on success). The shape matches the
 * existing `LintError` envelope so callers can splice these into the
 * same per-settle report.
 *
 * Paths matched: `workspaces/<w>/workflows/<slug>.{yaml,yml,md}` —
 * but the path is passed in by the caller; this function does not
 * dispatch on it. The caller picks files (see `lintWorkspace`'s diff
 * loop) and hands each one to `lintWorkflowFile`.
 *
 * The Markdown form is compiled to a `WorkflowDeclaration` via
 * `compileManagedAgentMdToWorkflow` before validation, so the same
 * `workflow_*` codes fire on both forms.
 */
/** Build the `trigger_ignored_on_managed_agent` lint error for a parsed
 *  managed-agent `.md`'s frontmatter, or `null` when it declares no
 *  `trigger:`. Shared by the `workflows/<slug>.md` shorthand path (in
 *  `lintWorkflowFile`) and the `managed-agents/<slug>.md` pass (in
 *  `lintWorkspace`), so both locations emit the identical error. */
function managedAgentTriggerError(frontMatter: Record<string, unknown>, filepath: string, workspace: string | undefined): LintError | null {
    if (frontMatter.trigger === undefined) return null;
    return {
        code: TRIGGER_IGNORED_ON_MANAGED_AGENT,
        path: filepath,
        workspace,
        message:
            `managed-agent '${filepath}' declares a 'trigger:' in frontmatter, but a trigger is a workflow concept — ` +
            `the managed-agent compile path drops it, so the cron would never register and the schedule never fires. ` +
            `Move the schedule to a cron workflow ('trigger.cron') whose agent step 'ref's this agent.`,
    };
}

export async function lintWorkflowFile(filepath: string, text: string, ctx: WorkflowValidateContext = {}): Promise<LintError[]> {
    const base = filepath.replace(/^.*\//, '');
    const stem = /^(.+?)(?:\.workflow)?\.(yaml|yml|md)$/.exec(base)?.[1];
    const workspace = workspaceOf(filepath);

    try {
        let decl;
        const extra: LintError[] = [];
        if (base.endsWith('.md')) {
            // Treat as managed-agent shorthand.
            const slug = stem ?? 'unknown';
            const md = parseManagedAgentMd(text, {
                slug,
                workspace: workspace ?? '',
            });
            // A `trigger:` on a managed-agent .md is silently dropped by the
            // compile path (it's a workflow-only concept) — surface it as an
            // authoring error instead of letting the cron vanish.
            const triggerErr = managedAgentTriggerError(md.frontMatter, filepath, workspace);
            if (triggerErr) extra.push(triggerErr);
            // Files with `extends:` chains can't be full-compiled at
            // lint time — `toAgentDeclaration` (called transitively
            // by compileManagedAgentMdToWorkflow) refuses to operate
            // on unresolved extends (§7.13.5). Resolution happens at
            // fragua boot via the registry's `composeExtends` pass.
            // The parse alone is sufficient validation here — the
            // frontmatter is well-formed; the body is preserved
            // verbatim; the extends target is a registry concern.
            if (md.frontMatter.extends !== undefined) {
                return extra;
            }
            decl = compileManagedAgentMdToWorkflow(md);
        } else {
            decl = parseWorkflowYaml(text, { filename: filepath });
        }
        const effectiveCtx: WorkflowValidateContext = {
            ...ctx,
            filename: ctx.filename ?? filepath,
        };
        const result = validateWorkflow(decl, effectiveCtx);
        return [...extra, ...result.errors.map((e) => workflowErrorToLintError(e, filepath, workspace))];
    } catch (e) {
        return [
            {
                code: 'workflow_parse_error',
                path: filepath,
                workspace,
                message: (e as Error).message,
            },
        ];
    }
}

/**
 * Lint a single `attachments.yaml` body — the standalone counterpart to
 * `lintWorkflowFile` for the attachments index. Returns the collected
 * `LintError[]` (empty on success), one `invalid_attachments_yaml` error per
 * structural issue `validateAttachmentsYaml` reports. Never throws.
 *
 * Like `lintWorkflowFile`, the caller picks the files; the `workspace`
 * attribution here is the flat first segment (no working-tree boundary scan
 * is available standalone) — `lintWorkspace`'s diff loop re-attributes
 * nesting-aware.
 */
export function lintAttachmentsFile(filepath: string, text: string): LintError[] {
    const workspace = workspaceOf(filepath);
    const { issues } = validateAttachmentsYaml(text);
    return issues.map((issue) => ({
        code: INVALID_ATTACHMENTS_YAML,
        path: filepath,
        workspace,
        message:
            issue.entryIndex === undefined
                ? `File ${filepath} is not a valid attachments index: ${issue.message}`
                : `File ${filepath} entry ${issue.entryIndex}: ${issue.message}`,
    }));
}

function workflowErrorToLintError(e: WorkflowValidationError, filepath: string, workspace: string | undefined): LintError {
    const stepHint = e.stepId ? ` (step "${e.stepId}")` : '';
    const fieldHint = e.field ? ` [field: ${e.field}]` : '';
    return {
        code: e.code,
        path: filepath,
        workspace,
        message: `${e.message}${stepHint}${fieldHint}`,
    };
}

/**
 * Test whether a path is a workflow source file the workflow lint
 * should run on. The settle-time integration uses this on every
 * post-stage file path. Exported so callers can wire the same predicate
 * into their own diff loops.
 */
export function isWorkflowPath(p: string): boolean {
    // `.workflow.meta.yaml` is the ernesto-frontmatter sidecar for a
    // `.workflow.js` dynamic workflow; it intentionally does NOT carry
    // a full WorkflowDeclaration shape, so the workflow lint rules don't
    // apply. The workspaces-reader parses the sidecar separately and
    // merges its fields into the declaration the .workflow.js provides.
    if (p.endsWith('.workflow.meta.yaml')) return false;
    return /^workspaces\/[^/]+\/workflows\/[^/]+\.(yaml|yml|md)$/.test(p);
}

/** Test whether a path is a managed-agent declaration:
 *  `workspaces/<w>/managed-agents/<slug>.md` (a direct child of a
 *  `managed-agents/` dir, at any workspace nesting depth). Exported so the
 *  settle-time loop and tests share one predicate. */
export function isManagedAgentPath(p: string): boolean {
    return /^workspaces\/.+\/managed-agents\/[^/]+\.md$/.test(p);
}
