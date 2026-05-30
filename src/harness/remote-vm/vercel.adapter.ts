/**
 * vercel.adapter.ts — concrete `SandboxClient` over `@vercel/sandbox`.
 *
 * ⚠️  NOT IMPORTED BY THE TYPECHECKED / TESTED PATH (*.adapter.ts is
 *     tsconfig-excluded). Lazy `import('@vercel/sandbox')`; adds no
 *     package.json dependency. Wired at spike/runtime time by passing the
 *     resulting client as `RemoteVmHarnessEnv.sandbox`.
 *
 * Implements the `SandboxClient` seam with the SDK moves proven in the live
 * e2e: `getOrCreate` (idempotent by name) → `updateNetworkPolicy` →
 * `writeFiles` → `runCommand` (detached for the mount; streamed stdout for
 * the agent via a PassThrough).
 *
 * CREDENTIAL NOTE: the production model brokers the backend bearer +
 * Anthropic key on egress (never in the VM). For first-light spikes,
 * `injectEnv` lets the adapter place short-lived creds into the exec env
 * (the adapter is the broker stand-in); flip to true egress brokering to
 * remove them from the VM entirely. The harness never carries them.
 *
 * @adapter-only
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { PassThrough } from 'stream';
import type {
    CreateOrResumeOpts,
    ExecOpts,
    ExecResult,
    ExecStreamHandle,
    NetworkPolicy,
    SandboxClient,
    SandboxFile,
    SandboxHandle,
} from './sandbox-client';

export interface VercelSandboxClientOpts {
    /** Vercel credentials. If omitted, the SDK resolves from VERCEL_OIDC_TOKEN. */
    token?: string;
    teamId?: string;
    projectId?: string;
    /** Sandbox runtime + lifetime. */
    runtime?: string;
    timeoutMs?: number;
    /** Extra env injected into EVERY exec (spike credential stand-in; in the
     *  brokered model this is empty and creds ride the egress proxy). */
    injectEnv?: Record<string, string>;
}

/** Map our NetworkPolicy → the Vercel `updateNetworkPolicy` shape. */
function toVercelPolicy(p: NetworkPolicy): any {
    return {
        // deny-all baseline; only the listed SNI domains (+ optional CIDRs) allowed.
        defaultPolicy: 'deny',
        allow: [
            ...p.allowDomains.map((domain) => ({ domain })),
            ...(p.allowCidrs ?? []).map((cidr) => ({ cidr })),
        ],
    };
}

export function createVercelSandboxClient(opts: VercelSandboxClientOpts): SandboxClient {
    const creds: Record<string, string> = {};
    if (opts.token) creds.token = opts.token;
    if (opts.teamId) creds.teamId = opts.teamId;
    if (opts.projectId) creds.projectId = opts.projectId;
    const injectEnv = opts.injectEnv ?? {};
    const runtime = opts.runtime ?? 'node24';
    const timeout = opts.timeoutMs ?? 15 * 60 * 1000;

    // Underlying Sandbox instances keyed by our opaque handle id.
    const byId = new Map<string, any>();

    async function sdk(): Promise<any> {
        const mod = await import('@vercel/sandbox');
        return (mod as any).Sandbox;
    }

    const client: SandboxClient = {
        async createOrResume(key: string, o: CreateOrResumeOpts): Promise<SandboxHandle> {
            const Sandbox = await sdk();
            const sbx = await Sandbox.getOrCreate({
                ...creds,
                name: key,
                runtime,
                timeout,
                ...(o.baseSnapshot ? { source: { type: 'snapshot', snapshotId: o.baseSnapshot } } : {}),
            });
            const id = sbx.sandboxId ?? sbx.id ?? key;
            byId.set(id, sbx);
            return { id };
        },

        async setNetworkPolicy(h: SandboxHandle, policy: NetworkPolicy): Promise<void> {
            const sbx = byId.get(h.id);
            if (!sbx?.updateNetworkPolicy) return; // best-effort; older SDKs
            await sbx.updateNetworkPolicy(toVercelPolicy(policy));
        },

        async writeFiles(h: SandboxHandle, files: SandboxFile[]): Promise<void> {
            const sbx = byId.get(h.id);
            await sbx.writeFiles(
                files.map((f) => ({
                    path: f.path,
                    content: Buffer.from(f.contentBase64, 'base64'),
                    ...(f.mode !== undefined ? { mode: f.mode } : {}),
                })),
            );
        },

        async exec(h: SandboxHandle, argv: string[], execOpts: ExecOpts = {}): Promise<ExecResult> {
            const sbx = byId.get(h.id);
            const env = { ...injectEnv, ...(execOpts.env ?? {}) };
            const params: any = { cmd: argv[0], args: argv.slice(1), env };
            if (execOpts.cwd) params.cwd = execOpts.cwd;
            if (execOpts.detached) {
                await sbx.runCommand({ ...params, detached: true });
                return { exitCode: 0, stdout: '', stderr: '' };
            }
            const c = await sbx.runCommand(params);
            const stdout = typeof c.stdout === 'function' ? await c.stdout() : (c.stdout ?? '');
            const stderr = typeof c.stderr === 'function' ? await c.stderr() : (c.stderr ?? '');
            return { exitCode: c.exitCode ?? 0, stdout: String(stdout), stderr: String(stderr) };
        },

        async execStream(h: SandboxHandle, argv: string[], execOpts: ExecOpts = {}): Promise<ExecStreamHandle> {
            const sbx = byId.get(h.id);
            const env = { ...injectEnv, ...(execOpts.env ?? {}) };
            const out = new PassThrough();
            const params: any = { cmd: argv[0], args: argv.slice(1), env, stdout: out };
            if (execOpts.cwd) params.cwd = execOpts.cwd;
            // runCommand resolves when the process exits; stdout streams to
            // `out` meanwhile. Keep the promise to await for `wait`.
            const done = sbx.runCommand(params).finally(() => out.end());
            return {
                stdout: out,
                async wait(): Promise<ExecResult> {
                    const c = await done;
                    return { exitCode: c?.exitCode ?? 0, stdout: '', stderr: '' };
                },
                async interrupt(): Promise<void> {
                    try { await sbx.runCommand({ cmd: 'pkill', args: ['-INT', 'claude'] }); } catch { /* best effort */ }
                },
            };
        },

        async readFile(h: SandboxHandle, path: string): Promise<Buffer> {
            const sbx = byId.get(h.id);
            if (typeof sbx.readFile === 'function') {
                const r = await sbx.readFile({ path });
                return Buffer.isBuffer(r) ? r : Buffer.from(await r.arrayBuffer?.() ?? r);
            }
            const c = await sbx.runCommand({ cmd: 'cat', args: [path] });
            const stdout = typeof c.stdout === 'function' ? await c.stdout() : c.stdout;
            return Buffer.from(String(stdout ?? ''));
        },

        async snapshot(h: SandboxHandle): Promise<{ snapshotId: string }> {
            const sbx = byId.get(h.id);
            const snap = await sbx.createSnapshot?.();
            return { snapshotId: snap?.snapshotId ?? snap?.id ?? '' };
        },

        async stop(h: SandboxHandle): Promise<void> {
            const sbx = byId.get(h.id);
            try { await sbx?.stop(); } finally { byId.delete(h.id); }
        },
    };

    return client;
}
