import { describe, expect, it } from 'vitest';
import {
    buildProvisionSpec,
    EDEN_LITE_PATH,
    WORKDIR_MOUNT,
} from '../provision';

describe('buildProvisionSpec', () => {
    const base = {
        agentKey: 'conv-123',
        backendBaseUrl: 'https://api.example.internal',
    };

    it('derives the deny-all egress policy when none supplied', () => {
        const spec = buildProvisionSpec(base);
        expect(spec.networkPolicy.allowDomains).toEqual([
            'api.example.internal',
            'api.anthropic.com',
        ]);
    });

    it('uses the agentKey as the idempotent sandbox key', () => {
        expect(buildProvisionSpec(base).key).toBe('conv-123');
    });

    it('binds the agent cwd to the FUSE mount and launches eden-lite there', () => {
        const spec = buildProvisionSpec(base);
        expect(spec.agentCwd).toBe(WORKDIR_MOUNT);
        expect(spec.mountArgv).toContain(EDEN_LITE_PATH);
        expect(spec.mountArgv).toContain(WORKDIR_MOUNT);
        expect(spec.mountArgv).toContain(base.backendBaseUrl);
    });

    it('carries the plain (token-less) backend URL in agent env, no secret', () => {
        const spec = buildProvisionSpec(base);
        expect(spec.agentEnv['ERNESTO_VM_BACKEND_URL']).toBe(base.backendBaseUrl);
        // Defense-in-depth: no agent env key looks like a credential.
        for (const k of Object.keys(spec.agentEnv)) {
            expect(k.toUpperCase()).not.toContain('TOKEN');
            expect(k.toUpperCase()).not.toContain('SECRET');
            expect(k.toUpperCase()).not.toContain('BEARER');
        }
    });

    it('shim file is non-secret and documents brokered egress', () => {
        const spec = buildProvisionSpec(base);
        expect(spec.files).toHaveLength(1);
        const shim = Buffer.from(
            spec.files[0]!.contentBase64,
            'base64',
        ).toString('utf8');
        expect(shim).toContain('NON-SECRET');
        expect(shim).toContain(base.backendBaseUrl);
        // No actual secret value smuggled in (an `sk-` key or a literal
        // `Bearer <token>` header value).
        expect(shim).not.toContain('sk-');
        expect(shim).not.toMatch(/Bearer\s+\S/);
    });

    it('threads principal as metadata (not into the VM env)', () => {
        const spec = buildProvisionSpec({ ...base, principal: 'user:42' });
        expect(spec.principal).toBe('user:42');
        // principal must NOT leak into the env handed to the VM.
        expect(JSON.stringify(spec.agentEnv)).not.toContain('user:42');
    });

    it('merges caller agentEnv on top of defaults', () => {
        const spec = buildProvisionSpec({
            ...base,
            agentEnv: { TERM: 'xterm', HOME: '/custom/home' },
        });
        expect(spec.agentEnv['TERM']).toBe('xterm');
        expect(spec.agentEnv['HOME']).toBe('/custom/home');
    });

    it('passes baseSnapshot through when set', () => {
        expect(buildProvisionSpec(base).baseSnapshot).toBeUndefined();
        expect(
            buildProvisionSpec({ ...base, baseSnapshot: 'snap-v1' }).baseSnapshot,
        ).toBe('snap-v1');
    });
});
