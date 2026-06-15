/**
 * Workspace attachments index — the `attachments.yaml` contract.
 *
 * `attachments.yaml` is a tracked git file at a workspace boundary listing the
 * binary attachments whose bytes live in the GeneratedStore
 * (`workspaces/{wsDir}/attached/{name}`). Every reader and writer of the index
 * — the backend author chokepoint, the sites upload path, the settle lint,
 * the GC sweep, the migration scripts — goes through this module so they all
 * agree on one schema, one validator, and one canonical serialization.
 */

import yaml from 'js-yaml';

export const ATTACHMENTS_YAML = 'attachments.yaml';
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/** Forward-compatible: required keys validated, extra keys preserved verbatim. */
export interface AttachmentEntry {
    /** Safe leaf filename ({@link isSafeAttachmentName}). */
    name: string;
    /** 64 lowercase hex chars. */
    sha256: string;
    /** Non-negative integer. */
    bytes: number;
    /** Non-empty string. */
    mimeType: string;
    /** String when present. */
    description?: string;
    /** Non-empty (ISO-8601 by convention; NOT date-parsed — forward-compatible). */
    attachedAt: string;
    /** Non-empty principal/caller id. */
    attachedBy: string;
    [extra: string]: unknown;
}

export interface AttachmentsYamlIssue {
    message: string;
    entryIndex?: number;
}

/**
 * String fields are deliberately NOT date-parsed (forward-compatible — see
 * {@link AttachmentEntry.attachedAt}), so an unquoted YAML timestamp
 * (`attachedAt: 2026-06-11T00:00:00Z`) parses to a `Date` and fails the
 * `typeof === 'string'` gate. The default message ("must be a … string") then
 * reads as a lie next to a file that visibly shows a timestamp. When the bad
 * value is a `Date`, point the editor straight at the fix — quote it — instead.
 */
function unquotedDateHint(field: string, value: unknown, fallback: string): string {
    if (value instanceof Date) {
        return `\`${field}\` must be a QUOTED string — an unquoted YAML timestamp parses as a date; wrap it in quotes`;
    }
    return fallback;
}

/**
 * Parse + structurally validate an `attachments.yaml` body. Never throws.
 * `''`/null-doc → `{ entries: [], issues: [] }`. A non-list top level or any
 * per-entry violation lands in `issues` (with `entryIndex` where applicable);
 * `entries` is best-effort — mapping entries are kept even when they carry
 * issues, so non-gating consumers (e.g. the GC mark phase) can still see them.
 * Extra keys are allowed and preserved verbatim.
 */
export function validateAttachmentsYaml(text: string): { entries: AttachmentEntry[]; issues: AttachmentsYamlIssue[] } {
    let parsed: unknown;
    try {
        parsed = yaml.load(text);
    } catch (err) {
        return { entries: [], issues: [{ message: `not parseable as YAML: ${err instanceof Error ? err.message : String(err)}` }] };
    }
    if (parsed === null || parsed === undefined) return { entries: [], issues: [] };
    if (!Array.isArray(parsed)) {
        return { entries: [], issues: [{ message: `top level must be a YAML list, got ${typeof parsed}` }] };
    }

    const entries: AttachmentEntry[] = [];
    const issues: AttachmentsYamlIssue[] = [];
    const seenNames = new Set<string>();
    parsed.forEach((raw, entryIndex) => {
        if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
            issues.push({ message: 'entry must be a YAML mapping', entryIndex });
            return;
        }
        const e = raw as Record<string, unknown>;
        if (typeof e.name !== 'string' || !isSafeAttachmentName(e.name)) {
            issues.push({ message: '`name` must be a safe leaf filename (no slash/backslash/NUL, not `.`/`..`, 1-255 chars)', entryIndex });
        } else if (seenNames.has(e.name)) {
            issues.push({ message: `duplicate name '${e.name}'`, entryIndex });
        } else {
            seenNames.add(e.name);
        }
        if (typeof e.sha256 !== 'string' || !SHA256_HEX_RE.test(e.sha256)) {
            issues.push({ message: '`sha256` must be 64 lowercase hex chars', entryIndex });
        }
        if (typeof e.bytes !== 'number' || !Number.isInteger(e.bytes) || e.bytes < 0) {
            issues.push({ message: '`bytes` must be a non-negative integer', entryIndex });
        }
        if (typeof e.mimeType !== 'string' || e.mimeType === '') {
            issues.push({ message: '`mimeType` must be a non-empty string', entryIndex });
        }
        if (e.description !== undefined && typeof e.description !== 'string') {
            issues.push({
                message: unquotedDateHint('description', e.description, '`description` must be a string when present'),
                entryIndex,
            });
        }
        if (typeof e.attachedAt !== 'string' || e.attachedAt === '') {
            issues.push({ message: unquotedDateHint('attachedAt', e.attachedAt, '`attachedAt` must be a non-empty string'), entryIndex });
        }
        if (typeof e.attachedBy !== 'string' || e.attachedBy === '') {
            issues.push({ message: '`attachedBy` must be a non-empty string', entryIndex });
        }
        entries.push(e as AttachmentEntry);
    });
    return { entries, issues };
}

/**
 * Canonical serialization: entries sorted by `name`, then dumped. Sorted order
 * is load-bearing, not cosmetic: concurrent appends of different names land on
 * different lines, so the settle 3-way merges them cleanly — every writer must
 * serialize through here for that line-stability to hold.
 */
export function serializeAttachmentsYaml(entries: ReadonlyArray<AttachmentEntry>): string {
    const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return yaml.dump(sorted, { lineWidth: -1, noRefs: true });
}

/** No `/`, `\`, or NUL; not `.` or `..`; 1-255 chars. */
export function isSafeAttachmentName(name: string): boolean {
    if (name.length < 1 || name.length > 255) return false;
    if (name.includes('/') || name.includes('\\') || name.includes('\0')) return false;
    if (name === '.' || name === '..') return false;
    return true;
}

/**
 * Collision-suffixed variant of a desired name: `sha256[0:8]` injected before
 * the LAST extension — `'playbook.pdf'` → `'playbook_5a8c0102.pdf'`. A name
 * without an extension (incl. a leading-dot name like `.env`) gets the plain
 * suffix appended.
 */
export function collisionSuffixedName(desiredName: string, sha256Hex: string): string {
    const shortSha = sha256Hex.slice(0, 8);
    const dot = desiredName.lastIndexOf('.');
    const ext = dot > 0 ? desiredName.slice(dot) : '';
    const stem = ext ? desiredName.slice(0, -ext.length) : desiredName;
    return `${stem}_${shortSha}${ext}`;
}

/** Pure; returns a new array. Replace-by-name (attach semantics), append when new. */
export function upsertAttachmentEntry(entries: ReadonlyArray<AttachmentEntry>, e: AttachmentEntry): AttachmentEntry[] {
    const i = entries.findIndex((existing) => existing.name === e.name);
    if (i === -1) return [...entries, e];
    const next = [...entries];
    next[i] = e;
    return next;
}

/** Pure; returns a new array and whether an entry was actually removed. */
export function removeAttachmentEntry(
    entries: ReadonlyArray<AttachmentEntry>,
    name: string,
): { entries: AttachmentEntry[]; removed: boolean } {
    const next = entries.filter((e) => e.name !== name);
    return { entries: next, removed: next.length !== entries.length };
}
