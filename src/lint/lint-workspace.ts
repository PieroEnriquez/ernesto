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
 *                                   `_`-prefix: only `_platform` allowed.
 *   forbidden_generated_path      — `workspaces/{w}/{routes,extracted}/` is
 *                                   derived; agents must not write.
 *   forbidden_workspace_md_delete — `WORKSPACE.md` is the contract; never
 *                                   delete it.
 *   archived_workspace_edit       — workspaces with `archived: true` only
 *                                   accept the unarchive flip.
 *   file_too_large                — any file > 1 MiB → fail.
 *   merge_markers                 — leftover git conflict markers from a
 *                                   stash pop or rebase.
 *   attachments_hand_edit         — `attachments.yaml` is route-only; any
 *                                   user-initiated edit is rejected.
 *                                   `_platform://attach` (write) and
 *                                   `_platform://detach` (admin) are the
 *                                   only paths.
 *   read_denied                   — diff touches `workspaces/{w}/**` and
 *                                   the principal lacks `{w}`'s `read:`
 *                                   scope (default: everyone). `write:`,
 *                                   `admin:`, and `ernesto:agent-ops` all
 *                                   satisfy.
 *   write_denied                  — diff modifies prose (anything other
 *                                   than WORKSPACE.md frontmatter or
 *                                   attachments.yaml) without `write:`.
 *                                   `write:` defaults to `read:`. `admin:`
 *                                   and `ernesto:agent-ops` satisfy.
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
 *     `attachments_hand_edit` and `merge_markers`.
 *   • `makeLintWorkspace(principal)` — closes over the principal's live
 *     scope set. Enforces every rule.
 */

import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import type { LintFn, LintError } from '../workdir/settle';
import { runGit } from '../workdir/run-git';

const GENERATED_SUBDIRS = ['routes', 'extracted'] as const;
const MAX_FILE_BYTES = 1024 * 1024;
const WORKSPACE_NAME_REGEX = /^[a-z][a-z0-9-]{0,39}$/;
const PLATFORM_WORKSPACE = '_platform';
const AGENT_OPS_SCOPE = 'ernesto:agent-ops';
const ATTACHMENTS_FILE = 'attachments.yaml';

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
        if (!header) { i++; continue; }

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
                if (l === '+++ /dev/null') { toPath = undefined; isDelete = true; }
                else {
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

function workspaceOf(p: string): string | undefined {
    const m = /^workspaces\/([^/]+)(?:\/.*)?$/.exec(p);
    return m?.[1];
}

function isGeneratedPath(p: string): boolean {
    const m = /^workspaces\/[^/]+\/([^/]+)(?:\/.*)?$/.exec(p);
    if (!m) return false;
    return (GENERATED_SUBDIRS as readonly string[]).includes(m[1]);
}

function isWorkspaceMd(p: string, w: string): boolean {
    return p === `workspaces/${w}/WORKSPACE.md`;
}

function isAttachmentsYaml(p: string, w: string): boolean {
    return p === `workspaces/${w}/${ATTACHMENTS_FILE}`;
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
    [k: string]: unknown;
}

interface FrontmatterParse { ok: true; data: Frontmatter; }
interface FrontmatterMissing { ok: false; reason: 'missing'; }
interface FrontmatterInvalid { ok: false; reason: 'invalid'; detail: string; }
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

async function readWorkspaceMdFromDisk(
    workingTreeRoot: string,
    workspace: string,
): Promise<{ exists: boolean; frontmatter?: Frontmatter }> {
    const file = path.join(workingTreeRoot, 'workspaces', workspace, 'WORKSPACE.md');
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
async function readOldFrontmatter(
    workingTreeRoot: string,
    workspace: string,
): Promise<{ exists: boolean; frontmatter?: Frontmatter }> {
    try {
        const content = await runGit(workingTreeRoot, [
            'show', `HEAD:workspaces/${workspace}/WORKSPACE.md`,
        ]);
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

function readScopeOf(fm: Frontmatter): string | undefined { return asStr(fm.read); }
function writeScopeOf(fm: Frontmatter): string | undefined { return asStr(fm.write); }
function adminScopeOf(fm: Frontmatter): string | undefined { return asStr(fm.admin); }

function hasAgentOps(p: LintPrincipal | undefined): boolean {
    return !!p && p.scopes.has(AGENT_OPS_SCOPE);
}

/** Read access. Default (no `read:`): everyone. `write`/`admin`/agent-ops bypass. */
function canRead(fm: Frontmatter, p: LintPrincipal | undefined): boolean {
    if (hasAgentOps(p)) return true;
    const r = readScopeOf(fm);
    if (r === undefined) return true;
    if (!p) return false;
    if (p.scopes.has(r)) return true;
    const w = writeScopeOf(fm);
    if (w !== undefined && p.scopes.has(w)) return true;
    const a = adminScopeOf(fm);
    if (a !== undefined && p.scopes.has(a)) return true;
    return false;
}

/** Write access. Default: same as read. `admin`/agent-ops bypass. */
function canWrite(fm: Frontmatter, p: LintPrincipal | undefined): boolean {
    if (hasAgentOps(p)) return true;
    const w = writeScopeOf(fm);
    const r = readScopeOf(fm);
    if (w === undefined && r === undefined) return true;
    if (!p) return false;
    const effectiveWrite = w ?? r;
    if (effectiveWrite !== undefined && p.scopes.has(effectiveWrite)) return true;
    const a = adminScopeOf(fm);
    if (a !== undefined && p.scopes.has(a)) return true;
    return false;
}

/** Admin access. No default — `admin:` is required. agent-ops bypass. */
function canAdmin(fm: Frontmatter, p: LintPrincipal | undefined): boolean {
    if (hasAgentOps(p)) return true;
    if (!p) return false;
    const a = adminScopeOf(fm);
    return a !== undefined && p.scopes.has(a);
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
    /** Rule codes to skip. Wired by privileged-route settles that legitimately
     *  modify route-only files (e.g. `_platform://attach` writes
     *  `attachments.yaml`, so the surrounding settle bypasses
     *  `attachments_hand_edit`). User-initiated settles must never set this. */
    bypass?: ReadonlySet<string>;
}

function build({ principal, bypass }: BuildOptions): LintFn {
    const isBypassed = (code: string): boolean => bypass?.has(code) ?? false;
    return async ({ diff, workspaces, workingTreeRoot }) => {
        const errors: LintError[] = [];
        const entries = parseDiff(diff);
        const declared = new Set(workspaces);
        const allowedPrefixes = workspaces.map(w => `workspaces/${w}/`);

        const touchedPaths = new Set<string>();
        for (const e of entries) {
            if (e.fromPath) touchedPaths.add(e.fromPath);
            if (e.toPath) touchedPaths.add(e.toPath);
        }

        // out_of_scope_path
        for (const p of touchedPaths) {
            const insideAny = allowedPrefixes.some(pref =>
                p === pref.slice(0, -1) || p.startsWith(pref),
            );
            if (!insideAny) {
                errors.push({
                    code: 'out_of_scope_path',
                    path: p,
                    message: `Path ${p} is not under any of: ${allowedPrefixes.join(', ')}`,
                });
            }
        }

        // forbidden_generated_path — bypassed by the derive worker's
        // privileged settle (`workspaces/{w}/routes/*` is settle-only and
        // the worker IS the settle).
        if (!isBypassed('forbidden_generated_path')) {
            for (const p of touchedPaths) {
                if (isGeneratedPath(p)) {
                    errors.push({
                        code: 'forbidden_generated_path',
                        workspace: workspaceOf(p),
                        path: p,
                        message: `Path ${p} is under a generated subdirectory (routes/, extracted/) and cannot be edited by hand`,
                    });
                }
            }
        }

        // forbidden_workspace_md_delete
        for (const e of entries) {
            if (!e.isDelete) continue;
            const p = e.fromPath;
            if (!p) continue;
            const w = workspaceOf(p);
            if (w && isWorkspaceMd(p, w)) {
                errors.push({
                    code: 'forbidden_workspace_md_delete',
                    workspace: w,
                    path: p,
                    message: `WORKSPACE.md for workspace '${w}' was deleted; this file is the workspace's contract`,
                });
            }
        }

        // attachments_hand_edit — always reject any touch (add, modify, delete).
        // Bypassed only by privileged-route settles (e.g. `_platform://attach`).
        if (!isBypassed('attachments_hand_edit')) {
            for (const p of touchedPaths) {
                const w = workspaceOf(p);
                if (w && isAttachmentsYaml(p, w)) {
                    errors.push({
                        code: 'attachments_hand_edit',
                        workspace: w,
                        path: p,
                        message: `attachments.yaml is route-only; use _platform://attach (write) or _platform://detach (admin) — hand-edits are rejected`,
                    });
                }
            }
        }

        // forbidden_workspace_name (new workspace creation only)
        for (const e of entries) {
            if (e.fromPath !== undefined) continue;
            if (!e.toPath) continue;
            const w = workspaceOf(e.toPath);
            if (!w || !isWorkspaceMd(e.toPath, w)) continue;
            if (w === PLATFORM_WORKSPACE) continue;
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

        // missing_frontmatter / invalid_frontmatter — reads post-stage from disk
        const touchedWorkspaceMds = new Set<string>();
        for (const e of entries) {
            const target = e.toPath;
            if (!target) continue;
            const w = workspaceOf(target);
            if (!w || !isWorkspaceMd(target, w)) continue;
            touchedWorkspaceMds.add(w);
        }
        for (const w of touchedWorkspaceMds) {
            const target = `workspaces/${w}/WORKSPACE.md`;
            let fileBody: string;
            try {
                fileBody = await readFile(path.join(workingTreeRoot, target), 'utf8');
            } catch {
                continue;
            }
            const fm = parseFrontmatter(fileBody);
            if (!fm.ok && fm.reason === 'missing') {
                errors.push({
                    code: 'missing_frontmatter', workspace: w, path: target,
                    message: `WORKSPACE.md for '${w}' is missing YAML frontmatter (must start with '---')`,
                });
                continue;
            }
            if (!fm.ok && fm.reason === 'invalid') {
                errors.push({
                    code: 'invalid_frontmatter', workspace: w, path: target,
                    message: `WORKSPACE.md for '${w}' has invalid frontmatter: ${fm.detail}`,
                });
                continue;
            }
            const data = fm.data;
            if (typeof data.name !== 'string' || data.name.trim() === '') {
                errors.push({
                    code: 'invalid_frontmatter', workspace: w, path: target,
                    message: `WORKSPACE.md for '${w}' frontmatter must declare a non-empty 'name'`,
                });
            } else if (data.name !== w) {
                errors.push({
                    code: 'invalid_frontmatter', workspace: w, path: target,
                    message: `WORKSPACE.md frontmatter 'name: ${data.name}' does not match directory name '${w}'`,
                });
            }
            if (typeof data.description !== 'string' || data.description.trim() === '') {
                errors.push({
                    code: 'invalid_frontmatter', workspace: w, path: target,
                    message: `WORKSPACE.md for '${w}' frontmatter must declare a non-empty 'description'`,
                });
            }
            if (typeof data.admin !== 'string' || data.admin.trim() === '') {
                errors.push({
                    code: 'invalid_frontmatter', workspace: w, path: target,
                    message: `WORKSPACE.md for '${w}' frontmatter must declare a non-empty 'admin' scope (required field)`,
                });
            }
        }

        // file_too_large + merge_markers (one pass per file)
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
                        workspace: workspaceOf(p),
                        message: `File ${p} is ${st.size} bytes; max allowed is ${MAX_FILE_BYTES}`,
                    });
                    continue;
                }
                const content = await readFile(abs, 'utf8');
                if (hasConflictMarkers(content)) {
                    errors.push({
                        code: 'merge_markers',
                        path: p,
                        workspace: workspaceOf(p),
                        message: `File ${p} contains unresolved git conflict markers; resolve them before settling`,
                    });
                }
            } catch {
                // best-effort
            }
        }

        // Per-workspace pass: workspace_md_missing, archived_workspace_edit,
        // and the read/write/admin scope rules.
        const touchedWorkspaces = new Set<string>();
        for (const p of touchedPaths) {
            const w = workspaceOf(p);
            if (w && declared.has(w)) touchedWorkspaces.add(w);
        }

        for (const w of touchedWorkspaces) {
            const ws = await readWorkspaceMdFromDisk(workingTreeRoot, w);

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

            // archived_workspace_edit
            if (fm.archived === true) {
                const touchedInWs = [...touchedPaths].filter(p => workspaceOf(p) === w);
                const onlyWorkspaceMd = touchedInWs.every(p => isWorkspaceMd(p, w));
                const wsMdEntry = entries.find(e => e.toPath && isWorkspaceMd(e.toPath, w));
                const newFmFromAdded = wsMdEntry ? parseFrontmatter(wsMdEntry.addedHead) : undefined;
                const unarchives = newFmFromAdded?.ok && newFmFromAdded.data.archived === false;
                if (!onlyWorkspaceMd || !unarchives) {
                    errors.push({
                        code: 'archived_workspace_edit',
                        workspace: w,
                        message: `Workspace '${w}' is archived; only the unarchive flip ('archived: false' in WORKSPACE.md) is allowed`,
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

            // Per-file write_denied / admin_denied.
            const oldFmRead = await readOldFrontmatter(workingTreeRoot, w);
            const wsEntries = entries.filter(e => {
                const t = e.toPath ?? e.fromPath;
                return t !== undefined && workspaceOf(t) === w;
            });

            for (const e of wsEntries) {
                const target = e.toPath ?? e.fromPath!;

                // attachments.yaml already handled by attachments_hand_edit.
                if (isAttachmentsYaml(target, w)) continue;

                // WORKSPACE.md edits: frontmatter changed → admin; body-only → write.
                if (isWorkspaceMd(target, w) && !e.isDelete) {
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
 * principal (shape, content, attachments_hand_edit, merge_markers). Suitable
 * for non-authoritative previews; the authoritative path always uses
 * `makeLintWorkspace(principal)`.
 */
export const lintWorkspace: LintFn = build({});

export interface MakeLintWorkspaceOptions {
    /** Rule codes the caller is privileged to skip. Wire only from routes
     *  that legitimately mutate route-only files (e.g. `_platform://attach`
     *  bypasses `attachments_hand_edit`). User-initiated settles must not
     *  pass this. */
    bypass?: ReadonlySet<string>;
}

/** Build a lint function bound to the principal's live scope set. */
export function makeLintWorkspace(
    principal: LintPrincipal,
    options: MakeLintWorkspaceOptions = {},
): LintFn {
    return build({ principal, bypass: options.bypass });
}
