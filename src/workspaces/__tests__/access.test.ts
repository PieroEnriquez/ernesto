import { describe, it, expect } from 'vitest';
import {
    parseWorkspaceFrontmatter,
    canRead,
    canWrite,
    canAdmin,
} from '../access';

const scopes = (...xs: string[]): ReadonlySet<string> => new Set(xs);

describe('parseWorkspaceFrontmatter', () => {
    it('parses a well-formed block into typed fields', () => {
        const fm = parseWorkspaceFrontmatter(
            '---\nname: pricing\nread: pricing:read\nowns:\n  - pricing://esim\n---\n\nprose\n',
        );
        expect(fm.name).toBe('pricing');
        expect(fm.read).toBe('pricing:read');
        expect(fm.owns).toEqual(['pricing://esim']);
    });

    it('returns {} when there is no frontmatter', () => {
        expect(parseWorkspaceFrontmatter('# just prose\n')).toEqual({});
    });

    it('returns {} on an unterminated block', () => {
        expect(parseWorkspaceFrontmatter('---\nname: x\n')).toEqual({});
    });

    it('returns {} on invalid YAML', () => {
        // Unterminated double-quote — yaml.load throws.
        expect(parseWorkspaceFrontmatter('---\nfoo: "bar\n---\n')).toEqual({});
    });

    it('returns {} when the frontmatter is a scalar or array, not a mapping', () => {
        expect(parseWorkspaceFrontmatter('---\n- a\n- b\n---\n')).toEqual({});
        expect(parseWorkspaceFrontmatter('---\njust a string\n---\n')).toEqual({});
    });

    it('drops wrong-typed fields', () => {
        const fm = parseWorkspaceFrontmatter('---\nread:\n  - not-a-string\nowns: nope\n---\n');
        expect(fm.read).toBeUndefined();
        expect(fm.owns).toBeUndefined();
    });

    it('tolerates a UTF-8 BOM before the opening fence', () => {
        expect(parseWorkspaceFrontmatter('﻿---\nname: x\n---\n').name).toBe('x');
    });
});

describe('canRead', () => {
    it('is public when no read is declared', () => {
        expect(canRead({}, scopes())).toBe(true);
    });

    it('requires the read scope once declared', () => {
        expect(canRead({ read: 'pricing:read' }, scopes())).toBe(false);
        expect(canRead({ read: 'pricing:read' }, scopes('pricing:read'))).toBe(true);
    });

    it('also grants read to holders of the write or admin scope', () => {
        expect(canRead({ read: 'r', write: 'w' }, scopes('w'))).toBe(true);
        expect(canRead({ read: 'r', admin: 'a' }, scopes('a'))).toBe(true);
    });

    it('treats a blank read string as not-declared (public)', () => {
        expect(canRead({ read: '   ' }, scopes())).toBe(true);
    });
});

describe('canWrite', () => {
    it('is public when neither write nor read is declared', () => {
        expect(canWrite({}, scopes())).toBe(true);
    });

    it('defaults to the read scope when no write is declared', () => {
        expect(canWrite({ read: 'r' }, scopes('r'))).toBe(true);
        expect(canWrite({ read: 'r' }, scopes())).toBe(false);
    });

    it('uses the write scope over read when declared', () => {
        expect(canWrite({ read: 'r', write: 'w' }, scopes('r'))).toBe(false);
        expect(canWrite({ read: 'r', write: 'w' }, scopes('w'))).toBe(true);
    });

    it('grants write to the admin scope', () => {
        expect(canWrite({ write: 'w', admin: 'a' }, scopes('a'))).toBe(true);
    });
});

describe('canAdmin', () => {
    it('is false when no admin is declared (no default)', () => {
        expect(canAdmin({ read: 'r' }, scopes('r'))).toBe(false);
    });

    it('is true only when the admin scope is held', () => {
        expect(canAdmin({ admin: 'a' }, scopes())).toBe(false);
        expect(canAdmin({ admin: 'a' }, scopes('a'))).toBe(true);
    });
});
