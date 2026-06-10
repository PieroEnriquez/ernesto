import { describe, it, expect } from 'vitest';
import { parseWorkspaceFrontmatter, canRead, canWrite, canAdmin, type WorkspaceFrontmatter } from '../access';

const scopes = (...xs: string[]): ReadonlySet<string> => new Set(xs);

describe('parseWorkspaceFrontmatter', () => {
    it('parses a well-formed block into typed fields', () => {
        const fm = parseWorkspaceFrontmatter('---\nname: pricing\nread: pricing:read\nowns:\n  - pricing://esim\n---\n\nprose\n');
        expect(fm.name).toBe('pricing');
        expect(fm.read).toBe('pricing:read');
        expect(fm.owns).toEqual(['pricing://esim']);
    });

    it('drops wrong-typed fields', () => {
        const fm = parseWorkspaceFrontmatter('---\nread:\n  - not-a-string\nowns: nope\n---\n');
        expect(fm.read).toBeUndefined();
        expect(fm.owns).toBeUndefined();
    });

    it('tolerates a UTF-8 BOM before the opening fence', () => {
        expect(parseWorkspaceFrontmatter('﻿---\nname: x\n---\n').name).toBe('x');
    });

    // Inputs that must parse to an empty object: no fence, unterminated block,
    // invalid YAML, and non-mapping (scalar / array) document bodies.
    const emptyCases: ReadonlyArray<[string, string]> = [
        ['returns {} when there is no frontmatter', '# just prose\n'],
        ['returns {} on an unterminated block', '---\nname: x\n'],
        // Unterminated double-quote — yaml.load throws.
        ['returns {} on invalid YAML', '---\nfoo: "bar\n---\n'],
        ['returns {} when the frontmatter is an array, not a mapping', '---\n- a\n- b\n---\n'],
        ['returns {} when the frontmatter is a scalar string, not a mapping', '---\njust a string\n---\n'],
    ];

    it.each(emptyCases)('%s', (_label, raw) => {
        expect(parseWorkspaceFrontmatter(raw)).toEqual({});
    });
});

type AccessCase = [string, WorkspaceFrontmatter, ReadonlySet<string>, boolean];

describe('canRead', () => {
    const cases: ReadonlyArray<AccessCase> = [
        // is public when no read is declared.
        ['public when no read is declared', {}, scopes(), true],
        // requires the read scope once declared.
        ['denied without the declared read scope', { read: 'pricing:read' }, scopes(), false],
        ['granted with the declared read scope', { read: 'pricing:read' }, scopes('pricing:read'), true],
        // also grants read to holders of the write or admin scope.
        ['granted via the write scope', { read: 'r', write: 'w' }, scopes('w'), true],
        ['granted via the admin scope', { read: 'r', admin: 'a' }, scopes('a'), true],
        // treats a blank read string as not-declared (public).
        ['blank read string is treated as public', { read: '   ' }, scopes(), true],
    ];

    it.each(cases)('%s', (_label, fm, held, expected) => {
        expect(canRead(fm, held)).toBe(expected);
    });
});

describe('canWrite', () => {
    const cases: ReadonlyArray<AccessCase> = [
        // is public when neither write nor read is declared.
        ['public when neither write nor read is declared', {}, scopes(), true],
        // defaults to the read scope when no write is declared.
        ['defaults to read scope (held)', { read: 'r' }, scopes('r'), true],
        ['defaults to read scope (missing)', { read: 'r' }, scopes(), false],
        // uses the write scope over read when declared.
        ['read scope does not satisfy a declared write', { read: 'r', write: 'w' }, scopes('r'), false],
        ['write scope satisfies a declared write', { read: 'r', write: 'w' }, scopes('w'), true],
        // grants write to the admin scope.
        ['granted via the admin scope', { write: 'w', admin: 'a' }, scopes('a'), true],
    ];

    it.each(cases)('%s', (_label, fm, held, expected) => {
        expect(canWrite(fm, held)).toBe(expected);
    });
});

describe('canAdmin', () => {
    const cases: ReadonlyArray<AccessCase> = [
        // is false when no admin is declared (no default).
        ['false when no admin is declared', { read: 'r' }, scopes('r'), false],
        // is true only when the admin scope is held.
        ['false without the admin scope', { admin: 'a' }, scopes(), false],
        ['true with the admin scope', { admin: 'a' }, scopes('a'), true],
    ];

    it.each(cases)('%s', (_label, fm, held, expected) => {
        expect(canAdmin(fm, held)).toBe(expected);
    });
});
