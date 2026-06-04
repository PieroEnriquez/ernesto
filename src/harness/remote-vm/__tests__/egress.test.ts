import { describe, expect, it } from 'vitest';
import { buildEgressPolicy, hostOf } from '../egress';

describe('hostOf', () => {
    it('parses https URLs to a bare hostname', () => {
        expect(hostOf('https://api.example.internal/vm/manifest')).toBe(
            'api.example.internal',
        );
    });
    it('strips port from host:port', () => {
        expect(hostOf('api.anthropic.com:443')).toBe('api.anthropic.com');
    });
    it('accepts a bare host', () => {
        expect(hostOf('api.anthropic.com')).toBe('api.anthropic.com');
    });
    it('strips a trailing path on a bare host', () => {
        expect(hostOf('host.example/some/path')).toBe('host.example');
    });
    it('throws (fail-closed) on empty input', () => {
        expect(() => hostOf('')).toThrow();
        expect(() => hostOf('   ')).toThrow();
    });
});

describe('buildEgressPolicy', () => {
    it('produces exactly the backend host + Anthropic default, deny-all', () => {
        const p = buildEgressPolicy({
            backendBaseUrl: 'https://api.example.internal',
        });
        expect(p.allowDomains).toEqual([
            'api.example.internal',
            'api.anthropic.com',
        ]);
        // Deny-all is implied: no wildcard, exactly two entries.
        expect(p.allowDomains).toHaveLength(2);
    });

    it('uses the supplied model host', () => {
        const p = buildEgressPolicy({
            backendBaseUrl: 'https://backend.host',
            modelBaseUrl: 'https://bedrock.example.com',
        });
        expect(p.allowDomains).toEqual(['backend.host', 'bedrock.example.com']);
    });

    it('collapses duplicates when backend == model host', () => {
        const p = buildEgressPolicy({
            backendBaseUrl: 'https://same.host/vm',
            modelBaseUrl: 'https://same.host/v1/messages',
        });
        expect(p.allowDomains).toEqual(['same.host']);
    });

    it('order is deterministic: backend first, then model', () => {
        const p = buildEgressPolicy({
            backendBaseUrl: 'https://zzz.backend',
            modelBaseUrl: 'https://aaa.model',
        });
        expect(p.allowDomains[0]).toBe('zzz.backend');
        expect(p.allowDomains[1]).toBe('aaa.model');
    });

    it('threads CIDRs through only when non-empty', () => {
        expect(
            buildEgressPolicy({ backendBaseUrl: 'https://b.host' }).allowCidrs,
        ).toBeUndefined();
        const withCidr = buildEgressPolicy({
            backendBaseUrl: 'https://b.host',
            allowCidrs: ['10.0.0.0/8'],
        });
        expect(withCidr.allowCidrs).toEqual(['10.0.0.0/8']);
    });
});
