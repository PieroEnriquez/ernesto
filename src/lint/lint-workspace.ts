/**
 * Tier-A `lintWorkspace` — the single settle gate.
 *
 * Enforces the workspace invariants from `domains/workspaces/README.md`
 * §22 (settle gate), §12 (governance), and §20 (lifecycle):
 *
 *   1. `out_of_scope_path`              — every touched path lives under
 *                                         `workspaces/{w}/` for a declared
 *                                         `w` in `workspaces[]`.
 *   2. `workspace_md_missing`           — every touched workspace has a
 *                                         `WORKSPACE.md` post-stage.
 *   3. `missing_frontmatter`            — modified `WORKSPACE.md` starts
 *      / `invalid_frontmatter`            with valid YAML frontmatter
 *                                         carrying `name:` and
 *                                         `description:`.
 *   4. `private_without_admins`         — `visibility: private` requires a
 *                                         non-empty `admins:` list.
 *   5. `forbidden_workspace_name`       — new workspaces must match
 *                                         `^[a-z][a-z0-9-]{0,39}$`. Names
 *                                         starting with `_` are reserved.
 *   6. `forbidden_generated_path`       — `workspaces/{w}/{routes,extracted}/`
 *                                         is derived; agents must not write.
 *   7. `forbidden_workspace_md_delete`  — `WORKSPACE.md` is the workspace's
 *                                         contract; never delete it.
 *   8. `archived_workspace_edit`        — workspaces with `archived: true`
 *                                         only accept the unarchive flip.
 *   9. `file_too_large`                 — any file > 1 MiB → fail.
 *  10. `platform_requires_agent_ops`    — `workspaces/_platform/**` writes
 *                                         require `ernesto:agent-ops`. The
 *                                         default scope-less lint fails
 *                                         conservatively (it cannot prove
 *                                         the principal holds the scope).
 *  11. `visibility_denied`              — §12 visibility rule. The
 *                                         principal's scope set must satisfy
 *                                         each touched workspace's
 *                                         `visibility:` (or be in
 *                                         `admins:` of `{w}`, or hold
 *                                         `ernesto:agent-ops`).
 *
 * Two surfaces:
 *   • `lintWorkspace` (default) — no principal info; runs every rule that
 *     does not depend on the live principal. The `_platform` rule fails
 *     conservatively because the lint cannot prove agent-ops; the §12
 *     visibility rule is skipped.
 *   • `makeLintWorkspace(principal)` — closes over the principal's scopes
 *     (and email, used for `admins:` matching). Enforces every rule.
 */

import { readFile, stat } from 'fs/promises';
import * as path from 'path';
import yaml from 'js-yaml';
import type { LintFn, LintError } from '../workdir/settle';

const GENERATED_SUBDIRS = ['routes', 'extracted'] as const;
const MAX_FILE_BYTES = 1024 * 1024;
const WORKSPACE_NAME_REGEX = /^[a-z][a-z0-9-]{0,39}$/;
const PLATFORM_WORKSPACE = '_platform';
const AGENT_OPS_SCOPE = 'ernesto:agent-ops';

interface DiffEntry {
    fromPath?: string;
    toPath?: string;
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

        entries.push({
            fromPath,
            toPath,
            isDelete,
            addedHead: addedLines.join('\n'),
        });
    }

    return entries;
}

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

interface Frontmatter {
    name?: unknown;
    description?: unknown;
    visibility?: unknown;
    admins?: unknown;
    archived?: unknown;
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
    if (!endMatch) {
        return { ok: false, reason: 'invalid', detail: 'unterminated frontmatter block' };
    }
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

async function readWorkspaceMd(
    workingTreeRoot: string,
    workspace: string,
): Promise<{ exists: boolean; frontmatter?: Frontmatter }> {
    const file = path.join(workingTreeRoot, 'workspaces', workspace, 'WORKSPACE.md');
    let body: string;
    try {
        body = await readFile(file, 'utf8');
    } catch {
        return { exists: false };
    }
    const fm = parseFrontmatter(body);
    return { exists: true, frontmatter: fm.ok ? fm.data : undefined };
}

/**
 * Detect leftover git conflict markers. Matches the same shape `git diff
 * --check` flags: a line starting with seven `<`, followed by a `=======`
 * separator, followed by a closing `>>>>>>> ` line. Diff3-style markers
 * (with `||||||| ` ancestor block) are also caught. Avoids false positives
 * on prose using `=======` as a markdown-ish thematic break by requiring
 * the full triplet.
 */
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

function asStringList(v: unknown): string[] | undefined {
    if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v as string[];
    return undefined;
}

function parseVisibility(v: unknown): 'public' | 'private' | string[] | undefined {
    if (v === undefined) return 'public';
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim();
    if (trimmed === '' || trimmed === 'public') return 'public';
    if (trimmed === 'private') return 'private';
    const slugs = trimmed.split(',').map(s => s.trim()).filter(s => s.length > 0);
    return slugs.length > 0 ? slugs : undefined;
}

export interface LintPrincipal {
    /** Live scope set. */
    scopes: ReadonlySet<string>;
    /** Email used for `admins:` membership matching (case-insensitive). */
    email?: string;
}

interface BuildOptions {
    /** When provided, enforces every rule including §12 + `_platform`.
     *  When omitted, the lint runs in scope-less mode: §12 is skipped and
     *  `_platform` writes fail conservatively. */
    principal?: LintPrincipal;
}

function principalIsAdminOf(admins: string[] | undefined, email?: string): boolean {
    if (!admins || !email) return false;
    const target = email.toLowerCase();
    return admins.some(a => a.toLowerCase() === target);
}

function principalSatisfiesVisibility(
    visibility: 'public' | 'private' | string[],
    admins: string[] | undefined,
    principal: LintPrincipal | undefined,
): boolean {
    if (visibility === 'public') return true;
    if (!principal) return false;
    if (principal.scopes.has(AGENT_OPS_SCOPE)) return true;
    if (principalIsAdminOf(admins, principal.email)) return true;
    if (visibility === 'private') return false;
    return visibility.some(slug => principal.scopes.has(slug));
}

function build({ principal }: BuildOptions): LintFn {
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

        // Rule 1: out_of_scope_path
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

        // Rule 6: forbidden_generated_path
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

        // Rule 7: forbidden_workspace_md_delete
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

        // Rule 10: platform_requires_agent_ops
        const platformPrefix = `workspaces/${PLATFORM_WORKSPACE}/`;
        const touchesPlatform = [...touchedPaths].some(p =>
            p === platformPrefix.slice(0, -1) || p.startsWith(platformPrefix),
        );
        if (touchesPlatform) {
            const allowed = principal?.scopes.has(AGENT_OPS_SCOPE) ?? false;
            if (!allowed) {
                errors.push({
                    code: 'platform_requires_agent_ops',
                    workspace: PLATFORM_WORKSPACE,
                    message: principal
                        ? `Edits under workspaces/_platform/** require the '${AGENT_OPS_SCOPE}' scope; principal does not hold it`
                        : `Edits under workspaces/_platform/** require the '${AGENT_OPS_SCOPE}' scope; scope-less lint cannot grant it`,
                });
            }
        }

        // Rule 5 (subset on creation): forbidden_workspace_name
        // A new workspace is signalled by an addition of WORKSPACE.md whose
        // fromPath is undefined.
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

        // Rules 3 + 4: WORKSPACE.md frontmatter shape — read post-stage from
        // disk so partial edits (which don't include the leading `---` block
        // in the diff's `+` lines) validate against the full file rather than
        // the inserted hunk.
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
                // File should exist post-stage; if it doesn't, the missing
                // rule below (workspace_md_missing) will surface that.
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
            if (data.visibility === 'private') {
                const adminsOk = Array.isArray(data.admins) && data.admins.length > 0;
                if (!adminsOk) {
                    errors.push({
                        code: 'private_without_admins',
                        workspace: w,
                        path: target,
                        message: `WORKSPACE.md for '${w}' declares 'visibility: private' but is missing a non-empty 'admins:' list`,
                    });
                }
            }
        }

        // Rule 9: file_too_large — read post-stage size from working tree.
        // Rule 12: merge_markers — leftover conflict markers from a stash
        //          pop or rebase. Same loop reads the file once and checks
        //          both invariants.
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
                        message: `File ${p} contains unresolved git conflict markers (<<<<<<<, =======, >>>>>>>); resolve them before settling`,
                    });
                }
            } catch {
                // File missing or unreadable — other rules surface that.
            }
        }

        // Touched-workspaces analysis (rules 2, 8, 11).
        const touchedWorkspaces = new Set<string>();
        for (const p of touchedPaths) {
            const w = workspaceOf(p);
            if (w && declared.has(w)) touchedWorkspaces.add(w);
        }

        for (const w of touchedWorkspaces) {
            const ws = await readWorkspaceMd(workingTreeRoot, w);

            // Rule 2: workspace_md_missing
            if (!ws.exists) {
                errors.push({
                    code: 'workspace_md_missing',
                    workspace: w,
                    message: `Workspace '${w}' has no WORKSPACE.md; create one before editing other files in it`,
                });
                continue;
            }

            const fm = ws.frontmatter ?? {};

            // Rule 8: archived_workspace_edit
            if (fm.archived === true) {
                const touchedInWs = [...touchedPaths].filter(p => workspaceOf(p) === w);
                const onlyWorkspaceMd = touchedInWs.every(p => isWorkspaceMd(p, w));
                const wsMdEntry = entries.find(e => e.toPath && isWorkspaceMd(e.toPath, w));
                const newFm = wsMdEntry ? parseFrontmatter(wsMdEntry.addedHead) : undefined;
                const unarchives = newFm?.ok && newFm.data.archived === false;
                if (!onlyWorkspaceMd || !unarchives) {
                    errors.push({
                        code: 'archived_workspace_edit',
                        workspace: w,
                        message: `Workspace '${w}' is archived; only the unarchive flip ('archived: false' in WORKSPACE.md) is allowed`,
                    });
                }
            }

            // Rule 11: visibility_denied (§12). Skipped in scope-less mode.
            if (principal) {
                const visibility = parseVisibility(fm.visibility);
                if (visibility === undefined) {
                    errors.push({
                        code: 'invalid_frontmatter',
                        workspace: w,
                        message: `Workspace '${w}' has an unparseable 'visibility:' value`,
                    });
                } else {
                    const admins = asStringList(fm.admins);
                    const ok = principalSatisfiesVisibility(visibility, admins, principal);
                    if (!ok) {
                        const desc = visibility === 'public' ? 'public'
                            : visibility === 'private' ? 'private'
                            : `[${visibility.join(', ')}]`;
                        errors.push({
                            code: 'visibility_denied',
                            workspace: w,
                            message: `Workspace '${w}' visibility ${desc} is not satisfied by principal scopes`,
                        });
                    }
                }
            }
        }

        return errors.length === 0 ? { ok: true } : { ok: false, errors };
    };
}

/**
 * Default scope-less lint. Enforces every rule that does not depend on the
 * principal. The `_platform` rule fails conservatively (no proof of
 * `ernesto:agent-ops`); the §12 visibility rule is skipped.
 */
export const lintWorkspace: LintFn = build({});

/** Build a lint function bound to the principal's live scope set + email. */
export function makeLintWorkspace(principal: LintPrincipal): LintFn {
    return build({ principal });
}
