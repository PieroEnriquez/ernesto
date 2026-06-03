/**
 * Workspace ACCESS MODEL — the single source of truth for the read/write/admin
 * decision and the `WORKSPACE.md` frontmatter parse.
 *
 * These semantics are CANONICAL: the settle gate (`lint/lint-workspace.ts`) and
 * the agent visibility surface (`workspaces/visibility.ts`) both decide access
 * from here, so a workspace the lint would let you commit to is exactly the one
 * the overlay surfaces — the two can no longer drift.
 *
 * Spec: domains/workspaces/README.md §12 (governance — read/write/admin scopes).
 *
 * The decision is PURE: it is a function of the parsed frontmatter and the
 * principal's scope set. The admin BYPASS (agent-ops, or the support preview)
 * is NOT decided here — each caller layers its own bypass on top before/around
 * these checks.
 *
 * Rules:
 *   - read:  no `read:` declared ⇒ public (everyone). Otherwise the principal
 *            must hold `read:`, OR `write:`, OR `admin:`.
 *   - write: defaults to `read:` (no `write:`/`read:` declared ⇒ public).
 *            Otherwise the principal must hold the effective write scope
 *            (`write ?? read`), OR `admin:`.
 *   - admin: no default — `admin:` must be declared AND held.
 */

import yaml from 'js-yaml';

/**
 * The access/identity fields a `WORKSPACE.md` frontmatter may declare. All
 * optional — a missing field is the documented default (e.g. no `read:` ⇒
 * public). Only the fields the access model and the workspace surfaces read are
 * modelled here; the lint validates additional shape rules on its own.
 */
export interface WorkspaceFrontmatter {
    name?: string;
    read?: string;
    write?: string;
    admin?: string;
    owns?: string[];
    recommends?: string[];
    description?: string;
}

function asString(v: unknown): string | undefined {
    return typeof v === 'string' ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) return undefined;
    return v as string[];
}

/**
 * Parse the leading `---`/YAML frontmatter block of a `WORKSPACE.md` body into
 * a typed {@link WorkspaceFrontmatter}. Robust to missing or malformed
 * frontmatter: any failure (no opening fence, unterminated block, non-mapping
 * YAML, parse error) yields an empty object. Per-field type-guards drop
 * wrong-typed values, so the result only carries well-typed fields.
 */
export function parseWorkspaceFrontmatter(md: string): WorkspaceFrontmatter {
    const trimmed = md.replace(/^﻿/, '');
    const startMatch = /^---\s*\n/.exec(trimmed);
    if (!startMatch) return {};

    const rest = trimmed.slice(startMatch[0].length);
    const endMatch = /\n---\s*(?:\n|$)/.exec(rest);
    if (!endMatch) return {};
    const yamlBody = rest.slice(0, endMatch.index);

    let parsed: unknown;
    try {
        parsed = yaml.load(yamlBody);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};

    const obj = parsed as Record<string, unknown>;
    const fm: WorkspaceFrontmatter = {};
    const name = asString(obj.name);
    if (name !== undefined) fm.name = name;
    const read = asString(obj.read);
    if (read !== undefined) fm.read = read;
    const write = asString(obj.write);
    if (write !== undefined) fm.write = write;
    const admin = asString(obj.admin);
    if (admin !== undefined) fm.admin = admin;
    const owns = asStringArray(obj.owns);
    if (owns !== undefined) fm.owns = owns;
    const recommends = asStringArray(obj.recommends);
    if (recommends !== undefined) fm.recommends = recommends;
    const description = asString(obj.description);
    if (description !== undefined) fm.description = description;
    return fm;
}

/** Trimmed non-empty string, else undefined — matches the lint's `asStr`. */
function scopeStr(v: string | undefined): string | undefined {
    return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

/**
 * Read access. No `read:` declared ⇒ public. Otherwise the principal must hold
 * the workspace's `read:`, `write:`, or `admin:` scope. Admin/agent-ops bypass
 * is the caller's concern.
 */
export function canRead(fm: WorkspaceFrontmatter, scopes: ReadonlySet<string>): boolean {
    const r = scopeStr(fm.read);
    if (r === undefined) return true;
    if (scopes.has(r)) return true;
    const w = scopeStr(fm.write);
    if (w !== undefined && scopes.has(w)) return true;
    const a = scopeStr(fm.admin);
    if (a !== undefined && scopes.has(a)) return true;
    return false;
}

/**
 * Write access. Defaults to read (no `write:`/`read:` ⇒ public). Otherwise the
 * principal must hold the effective write scope (`write ?? read`) or `admin:`.
 */
export function canWrite(fm: WorkspaceFrontmatter, scopes: ReadonlySet<string>): boolean {
    const w = scopeStr(fm.write);
    const r = scopeStr(fm.read);
    if (w === undefined && r === undefined) return true;
    const effectiveWrite = w ?? r;
    if (effectiveWrite !== undefined && scopes.has(effectiveWrite)) return true;
    const a = scopeStr(fm.admin);
    if (a !== undefined && scopes.has(a)) return true;
    return false;
}

/** Admin access. No default — `admin:` must be declared and held. */
export function canAdmin(fm: WorkspaceFrontmatter, scopes: ReadonlySet<string>): boolean {
    const a = scopeStr(fm.admin);
    return a !== undefined && scopes.has(a);
}
