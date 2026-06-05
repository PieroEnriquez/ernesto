import { describe, it, expect } from 'vitest';
import { validateTreeRelPath } from '../path';

describe('validateTreeRelPath', () => {
    // (label, input, expected) — `expected` is the normalized path on accept,
    // or null on reject. Each row preserves a former bespoke `it` assertion.
    const cases: ReadonlyArray<[string, unknown, string | null]> = [
        // accept: a clean tree-relative path is returned unchanged.
        [
            'accepts a clean tree-relative path',
            'workspaces/product/pricing/esim.md',
            'workspaces/product/pricing/esim.md',
        ],
        // reject: non-strings.
        ['rejects undefined', undefined, null],
        ['rejects a number', 42, null],
        ['rejects null', null, null],
        // reject: an absolute path (leading slash).
        ['rejects an absolute path (leading slash)', '/etc/passwd', null],
        // reject: `..` traversal at any depth.
        ['rejects `..` traversal at the top', 'workspaces/../secret', null],
        ['rejects `..` traversal mid-path', 'a/b/../../c', null],
        // reject: single-dot and empty segments.
        ['rejects a single-dot segment', 'a/./b', null],
        ['rejects an empty segment', 'a//b', null],
        // reject: NUL and backslash.
        ['rejects a NUL byte', 'a/\0/b', null],
        ['rejects a backslash', 'a\\b', null],
        // reject: an over-length path.
        ['rejects an over-length path', 'a/'.repeat(3000), null],
    ];

    it.each(cases)('%s', (_label, input, expected) => {
        expect(validateTreeRelPath(input as string)).toBe(expected);
    });
});
