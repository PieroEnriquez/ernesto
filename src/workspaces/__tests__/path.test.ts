import { describe, it, expect } from 'vitest';
import { validateTreeRelPath } from '../path';

describe('validateTreeRelPath', () => {
    it('accepts a clean tree-relative path', () => {
        expect(validateTreeRelPath('workspaces/product/pricing/esim.md'))
            .toBe('workspaces/product/pricing/esim.md');
    });

    it('rejects non-strings', () => {
        expect(validateTreeRelPath(undefined)).toBeNull();
        expect(validateTreeRelPath(42)).toBeNull();
        expect(validateTreeRelPath(null)).toBeNull();
    });

    it('rejects an absolute path (leading slash)', () => {
        expect(validateTreeRelPath('/etc/passwd')).toBeNull();
    });

    it('rejects `..` traversal at any depth', () => {
        expect(validateTreeRelPath('workspaces/../secret')).toBeNull();
        expect(validateTreeRelPath('a/b/../../c')).toBeNull();
    });

    it('rejects single-dot and empty segments', () => {
        expect(validateTreeRelPath('a/./b')).toBeNull();
        expect(validateTreeRelPath('a//b')).toBeNull();
    });

    it('rejects NUL and backslash', () => {
        expect(validateTreeRelPath('a/\0/b')).toBeNull();
        expect(validateTreeRelPath('a\\b')).toBeNull();
    });

    it('rejects an over-length path', () => {
        expect(validateTreeRelPath('a/'.repeat(3000))).toBeNull();
    });
});
