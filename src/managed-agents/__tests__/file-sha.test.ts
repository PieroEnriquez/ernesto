/**
 * Unit tests for `gitBlobShaOf` — verifies parity with git's own
 * `hash-object` so the approval flow's content-integrity check can't
 * drift from what git computes.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { gitBlobShaOf, verifyContentMatchesFileSha } from '../file-sha';

function gitHashObject(content: string): string {
    const tmp = mkdtempSync(join(tmpdir(), 'git-blob-sha-'));
    try {
        const path = join(tmp, 'f.md');
        writeFileSync(path, content, 'utf8');
        return execFileSync('git', ['hash-object', path], { encoding: 'utf8' }).trim();
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

describe('gitBlobShaOf', () => {
    it('matches git hash-object on a short ASCII string', () => {
        const content = 'hello world\n';
        expect(gitBlobShaOf(content)).toBe(gitHashObject(content));
    });

    it('matches git hash-object on multi-byte UTF-8 (length = byte count, not char count)', () => {
        const content = '日本語\n';
        expect(gitBlobShaOf(content)).toBe(gitHashObject(content));
    });

    it('matches git hash-object on a multi-line markdown body', () => {
        const content = `---
slug: a
name: A
---

Body line one.
Body line two with a backtick: \`code\`.
`;
        expect(gitBlobShaOf(content)).toBe(gitHashObject(content));
    });

    it('matches git hash-object on the empty string', () => {
        // git's known blob sha for empty content
        expect(gitBlobShaOf('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
        expect(gitHashObject('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
    });
});

describe('verifyContentMatchesFileSha', () => {
    it('returns true on match', () => {
        const content = 'a body\n';
        expect(verifyContentMatchesFileSha(content, gitBlobShaOf(content))).toBe(true);
    });

    it('returns false on any byte difference', () => {
        const a = 'a body\n';
        const b = 'a  body\n';
        expect(verifyContentMatchesFileSha(b, gitBlobShaOf(a))).toBe(false);
    });
});
