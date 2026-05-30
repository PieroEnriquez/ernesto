/**
 * vercel.adapter.ts — SPIKE-ONLY concrete `SandboxClient`.
 *
 * ⚠️  NOT IMPORTED BY THE TYPECHECKED / TESTED PATH.  ⚠️
 *
 * This file binds the `SandboxClient` seam to the real Vercel Sandbox
 * SDK (`@vercel/sandbox`). It needs that package + Vercel credentials at
 * runtime, neither of which exists on the dev laptop (macOS, no FUSE, no
 * Vercel creds). To keep the build green and the unit tests native-dep-
 * free, this module:
 *
 *   - is excluded from `tsconfig` compilation (`*.adapter.ts` is off the
 *     tested graph — see the harness Build Contract §3/§4);
 *   - does a LAZY `import()` of `@vercel/sandbox` so merely importing
 *     this file (e.g. by a future entrypoint) doesn't resolve the dep
 *     until `createVercelSandboxClient()` is actually called;
 *   - adds NO entry to `package.json` dependencies.
 *
 * Wire it up during the Vercel spike: install `@vercel/sandbox`, drop
 * this file onto the build graph (or load it dynamically from the runner)
 * and pass the resulting client as `RemoteVmHarnessEnv.sandbox`.
 *
 * CREDENTIAL DISCIPLINE: this adapter MUST apply the egress firewall via
 * `setNetworkPolicy` before any agent code runs and MUST NOT place the
 * scoped backend bearer or the Anthropic key into the VM env — those are
 * injected by the egress proxy on the way out (Build Contract §4/§5).
 *
 * The body below is illustrative pseudo-binding: the exact Vercel SDK
 * surface is pinned during the spike. It is deliberately untyped against
 * the real SDK (no top-level import) so this file never breaks the build.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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

/** Construction options resolved by the runner at spike time. */
export interface VercelSandboxClientOpts {
    /** Vercel project / team identifiers, OIDC token source, etc. */
    projectId: string;
    /** Egress proxy endpoint that injects the brokered credentials. The
     *  scoped backend bearer + Anthropic key live HERE, host-side, never
     *  in the VM. */
    egressProxyUrl: string;
}

/**
 * Build a Vercel-backed `SandboxClient`. SPIKE-ONLY. Throws if
 * `@vercel/sandbox` is not installed — by design, so an accidental
 * import on the laptop fails loud rather than silently degrading.
 */
export function createVercelSandboxClient(
    opts: VercelSandboxClientOpts,
): SandboxClient {
    const loadSdk = async (): Promise<any> => {
        // Lazy, dynamic import keeps the dep off the static graph. The
        // string is assembled so a bundler can't eagerly resolve it.
        const mod = '@vercel/' + 'sandbox';
        return import(mod);
    };

    return {
        async createOrResume(
            key: string,
            createOpts: CreateOrResumeOpts,
        ): Promise<SandboxHandle> {
            const sdk = await loadSdk();
            const sandbox = await sdk.Sandbox.create({
                // Idempotent name keyed to the conversation; resume on
                // re-create.
                name: key,
                snapshot: createOpts.baseSnapshot,
            });
            return { id: sandbox.id };
        },

        async setNetworkPolicy(
            h: SandboxHandle,
            policy: NetworkPolicy,
        ): Promise<void> {
            const sdk = await loadSdk();
            // Deny-all TLS-SNI + allowlist. MUST run before agent code.
            await sdk.Sandbox.get(h.id).then((s: any) =>
                s.setNetworkPolicy({
                    defaultAction: 'deny',
                    allowDomains: policy.allowDomains,
                    allowCidrs: policy.allowCidrs ?? [],
                    // The egress proxy injects the brokered creds.
                    egressProxy: opts.egressProxyUrl,
                }),
            );
        },

        async writeFiles(h: SandboxHandle, files: SandboxFile[]): Promise<void> {
            const sdk = await loadSdk();
            const s = await sdk.Sandbox.get(h.id);
            await s.writeFiles(
                files.map((f) => ({
                    path: f.path,
                    content: Buffer.from(f.contentBase64, 'base64'),
                    mode: f.mode,
                })),
            );
        },

        async exec(
            h: SandboxHandle,
            argv: string[],
            execOpts?: ExecOpts,
        ): Promise<ExecResult> {
            const sdk = await loadSdk();
            const s = await sdk.Sandbox.get(h.id);
            const r = await s.runCommand({
                cmd: argv[0],
                args: argv.slice(1),
                env: execOpts?.env, // NON-SECRET only — see file header.
                cwd: execOpts?.cwd,
                detached: execOpts?.detached,
            });
            return {
                exitCode: r.exitCode ?? 0,
                stdout: r.stdout ?? '',
                stderr: r.stderr ?? '',
            };
        },

        async execStream(
            h: SandboxHandle,
            argv: string[],
            execOpts?: ExecOpts,
        ): Promise<ExecStreamHandle> {
            const sdk = await loadSdk();
            const s = await sdk.Sandbox.get(h.id);
            const cmd = await s.runCommand({
                cmd: argv[0],
                args: argv.slice(1),
                env: execOpts?.env,
                cwd: execOpts?.cwd,
                stream: true,
            });
            return {
                stdout: cmd.stdout as AsyncIterable<Buffer | string>,
                wait: async (): Promise<ExecResult> => {
                    const r = await cmd.wait();
                    return {
                        exitCode: r.exitCode ?? 0,
                        stdout: '',
                        stderr: r.stderr ?? '',
                    };
                },
                interrupt: async (): Promise<void> => {
                    await cmd.kill?.('SIGINT');
                },
            };
        },

        async readFile(h: SandboxHandle, path: string): Promise<Buffer> {
            const sdk = await loadSdk();
            const s = await sdk.Sandbox.get(h.id);
            const data = await s.readFile(path);
            return Buffer.isBuffer(data) ? data : Buffer.from(data);
        },

        async snapshot(h: SandboxHandle): Promise<{ snapshotId: string }> {
            const sdk = await loadSdk();
            const s = await sdk.Sandbox.get(h.id);
            const snap = await s.snapshot();
            return { snapshotId: snap.id };
        },

        async stop(h: SandboxHandle): Promise<void> {
            const sdk = await loadSdk();
            const s = await sdk.Sandbox.get(h.id);
            await s.stop();
        },
    };
}
