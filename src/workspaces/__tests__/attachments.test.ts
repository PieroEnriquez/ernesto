import { describe, it, expect } from 'vitest';
import {
    ATTACHMENTS_YAML,
    SHA256_HEX_RE,
    validateAttachmentsYaml,
    serializeAttachmentsYaml,
    isSafeAttachmentName,
    collisionSuffixedName,
    upsertAttachmentEntry,
    removeAttachmentEntry,
    type AttachmentEntry,
} from '../attachments';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function entry(overrides: Partial<AttachmentEntry> = {}): AttachmentEntry {
    return {
        name: 'playbook.pdf',
        sha256: SHA_A,
        bytes: 1024,
        mimeType: 'application/pdf',
        attachedAt: '2026-06-11T00:00:00Z',
        attachedBy: 'user:piero',
        ...overrides,
    };
}

describe('validateAttachmentsYaml', () => {
    it('treats empty text and a null doc as an empty index', () => {
        expect(validateAttachmentsYaml('')).toEqual({ entries: [], issues: [] });
        expect(validateAttachmentsYaml('# just a comment\n')).toEqual({ entries: [], issues: [] });
    });

    it('never throws — unparseable YAML becomes an issue', () => {
        const { entries, issues } = validateAttachmentsYaml('foo: [unclosed');
        expect(entries).toEqual([]);
        expect(issues).toHaveLength(1);
        expect(issues[0].message).toMatch(/not parseable/);
    });

    it('rejects a non-list top level', () => {
        const { entries, issues } = validateAttachmentsYaml('name: not-a-list\n');
        expect(entries).toEqual([]);
        expect(issues).toEqual([{ message: 'top level must be a YAML list, got object' }]);
    });

    it('rejects a non-mapping entry with its index', () => {
        const { entries, issues } = validateAttachmentsYaml(serializeAttachmentsYaml([entry()]) + '- just-a-string\n');
        expect(entries).toHaveLength(1);
        expect(issues).toEqual([{ message: 'entry must be a YAML mapping', entryIndex: 1 }]);
    });

    // Every required-key violation: missing key AND wrong type both flag.
    const violations: ReadonlyArray<[string, Partial<AttachmentEntry>, RegExp]> = [
        ['name missing', { name: undefined }, /`name`/],
        ['name not a string', { name: 42 as unknown as string }, /`name`/],
        ['sha256 missing', { sha256: undefined }, /`sha256`/],
        ['sha256 wrong length', { sha256: 'abc123' }, /`sha256`/],
        ['sha256 uppercase hex', { sha256: SHA_A.toUpperCase() }, /`sha256`/],
        ['bytes missing', { bytes: undefined }, /`bytes`/],
        ['bytes negative', { bytes: -1 }, /`bytes`/],
        ['bytes non-integer', { bytes: 1.5 }, /`bytes`/],
        ['bytes not a number', { bytes: '1024' as unknown as number }, /`bytes`/],
        ['mimeType missing', { mimeType: undefined }, /`mimeType`/],
        ['mimeType empty', { mimeType: '' }, /`mimeType`/],
        ['description not a string', { description: 7 as unknown as string }, /`description`/],
        ['attachedAt missing', { attachedAt: undefined }, /`attachedAt`/],
        ['attachedAt empty', { attachedAt: '' }, /`attachedAt`/],
        ['attachedBy missing', { attachedBy: undefined }, /`attachedBy`/],
        ['attachedBy empty', { attachedBy: '' }, /`attachedBy`/],
    ];

    it.each(violations)('flags %s', (_label, overrides, messageRe) => {
        const bad = { ...entry(), ...overrides };
        for (const k of Object.keys(bad)) {
            if ((bad as Record<string, unknown>)[k] === undefined) delete (bad as Record<string, unknown>)[k];
        }
        const { entries, issues } = validateAttachmentsYaml(serializeAttachmentsYaml([bad as AttachmentEntry]));
        expect(issues).toHaveLength(1);
        expect(issues[0].entryIndex).toBe(0);
        expect(issues[0].message).toMatch(messageRe);
        // Best-effort: the entry is still surfaced alongside its issues.
        expect(entries).toHaveLength(1);
    });

    it('accepts a valid entry without a description', () => {
        const { entries, issues } = validateAttachmentsYaml(serializeAttachmentsYaml([entry()]));
        expect(issues).toEqual([]);
        expect(entries).toEqual([entry()]);
    });

    it('flags unsafe names', () => {
        for (const name of ['../x', 'a/b', '.']) {
            const { issues } = validateAttachmentsYaml(serializeAttachmentsYaml([entry({ name })]));
            expect(issues).toHaveLength(1);
            expect(issues[0].message).toMatch(/`name`/);
        }
    });

    it('flags duplicate names (exact, case-sensitive — a case variant is NOT a dup)', () => {
        const dup = validateAttachmentsYaml(serializeAttachmentsYaml([entry(), entry({ sha256: SHA_B })]));
        expect(dup.issues).toEqual([{ message: "duplicate name 'playbook.pdf'", entryIndex: 1 }]);
        expect(dup.entries).toHaveLength(2);

        const caseVariant = validateAttachmentsYaml(serializeAttachmentsYaml([entry(), entry({ name: 'Playbook.pdf', sha256: SHA_B })]));
        expect(caseVariant.issues).toEqual([]);
    });

    it('preserves extra keys verbatim', () => {
        const withExtras = entry({ source: 'slack', pinned: true, meta: { from: 'C123' } });
        const { entries, issues } = validateAttachmentsYaml(serializeAttachmentsYaml([withExtras]));
        expect(issues).toEqual([]);
        expect(entries[0].source).toBe('slack');
        expect(entries[0].pinned).toBe(true);
        expect(entries[0].meta).toEqual({ from: 'C123' });
    });
});

describe('serializeAttachmentsYaml', () => {
    it('round-trips through validateAttachmentsYaml', () => {
        const input = [entry({ name: 'b.pdf' }), entry({ name: 'a.pdf', sha256: SHA_B, description: 'notes' })];
        const { entries, issues } = validateAttachmentsYaml(serializeAttachmentsYaml(input));
        expect(issues).toEqual([]);
        expect(serializeAttachmentsYaml(entries)).toBe(serializeAttachmentsYaml(input));
    });

    it('sorts entries by name and does not mutate the input', () => {
        const input = [entry({ name: 'z.pdf' }), entry({ name: 'a.pdf', sha256: SHA_B })];
        const out = serializeAttachmentsYaml(input);
        const { entries } = validateAttachmentsYaml(out);
        expect(entries.map((e) => e.name)).toEqual(['a.pdf', 'z.pdf']);
        expect(input[0].name).toBe('z.pdf');
    });

    it('serializes the same set identically regardless of input order (canonical form)', () => {
        const a = entry({ name: 'a.pdf' });
        const b = entry({ name: 'b.pdf', sha256: SHA_B });
        expect(serializeAttachmentsYaml([a, b])).toBe(serializeAttachmentsYaml([b, a]));
    });
});

describe('isSafeAttachmentName', () => {
    it('accepts ordinary leaf filenames', () => {
        expect(isSafeAttachmentName('playbook.pdf')).toBe(true);
        expect(isSafeAttachmentName('.env')).toBe(true);
        expect(isSafeAttachmentName('a')).toBe(true);
        expect(isSafeAttachmentName('x'.repeat(255))).toBe(true);
    });

    it('rejects separators, NUL, dot segments, and bad lengths', () => {
        expect(isSafeAttachmentName('a/b')).toBe(false);
        expect(isSafeAttachmentName('a\\b')).toBe(false);
        expect(isSafeAttachmentName('a\0b')).toBe(false);
        expect(isSafeAttachmentName('../x')).toBe(false);
        expect(isSafeAttachmentName('.')).toBe(false);
        expect(isSafeAttachmentName('..')).toBe(false);
        expect(isSafeAttachmentName('')).toBe(false);
        expect(isSafeAttachmentName('x'.repeat(256))).toBe(false);
    });
});

describe('collisionSuffixedName', () => {
    const sha = '5a8c0102' + 'f'.repeat(56);

    it('injects sha256[0:8] before the last extension', () => {
        expect(collisionSuffixedName('playbook.pdf', sha)).toBe('playbook_5a8c0102.pdf');
        expect(collisionSuffixedName('archive.tar.gz', sha)).toBe('archive.tar_5a8c0102.gz');
    });

    it('appends a plain suffix when there is no extension', () => {
        expect(collisionSuffixedName('README', sha)).toBe('README_5a8c0102');
        // A leading dot is a dotfile, not an extension.
        expect(collisionSuffixedName('.env', sha)).toBe('.env_5a8c0102');
    });
});

describe('upsertAttachmentEntry / removeAttachmentEntry', () => {
    it('upsert appends a new name and replaces an existing one in place', () => {
        const base = [entry({ name: 'a.pdf' })];
        const appended = upsertAttachmentEntry(base, entry({ name: 'b.pdf', sha256: SHA_B }));
        expect(appended.map((e) => e.name)).toEqual(['a.pdf', 'b.pdf']);

        const replaced = upsertAttachmentEntry(appended, entry({ name: 'a.pdf', sha256: SHA_B }));
        expect(replaced).toHaveLength(2);
        expect(replaced[0].sha256).toBe(SHA_B);
        // Pure: the inputs are untouched.
        expect(base).toHaveLength(1);
        expect(appended[0].sha256).toBe(SHA_A);
    });

    it('remove reports whether anything was removed and never mutates', () => {
        const base = [entry({ name: 'a.pdf' }), entry({ name: 'b.pdf', sha256: SHA_B })];
        const hit = removeAttachmentEntry(base, 'a.pdf');
        expect(hit.removed).toBe(true);
        expect(hit.entries.map((e) => e.name)).toEqual(['b.pdf']);

        const miss = removeAttachmentEntry(base, 'nope.pdf');
        expect(miss.removed).toBe(false);
        expect(miss.entries).toHaveLength(2);
        expect(base).toHaveLength(2);
    });
});

describe('constants', () => {
    it('exports the filename and the sha shape', () => {
        expect(ATTACHMENTS_YAML).toBe('attachments.yaml');
        expect(SHA256_HEX_RE.test(SHA_A)).toBe(true);
        expect(SHA256_HEX_RE.test(SHA_A.toUpperCase())).toBe(false);
        expect(SHA256_HEX_RE.test('a'.repeat(63))).toBe(false);
    });
});
