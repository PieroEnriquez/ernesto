/**
 * `SandboxClient` — the internal runtime seam for the remote-vm harness.
 *
 * Everything the harness needs from the underlying microVM platform
 * (Vercel Sandbox today) is expressed through this small pure interface.
 * The harness logic — egress-policy building, provision-spec building, the
 * SDK-message → `HarnessEvent` mapping, lifecycle orchestration — is coded
 * and unit-tested against this interface with an in-memory stub.
 *
 * The CONCRETE implementation lives in the backend
 * (`ernesto/vm/sandbox/vercel-sandbox-client.ts`) where the Vercel SDK +
 * creds belong; tests implement an in-memory stub. This file imports no
 * cloud SDK and adds no runtime dependency.
 */

/**
 * Egress firewall declaration. Deny-all by default; only the listed
 * destinations are reachable from inside the VM. For the remote-vm layer
 * the allowlist is exactly two hosts: the backend API (serving `/vm/*`)
 * and the Anthropic model endpoint. There is no third destination, so
 * full Bash + WebFetch inside the VM cannot exfiltrate.
 */
export interface NetworkPolicy {
    /** TLS-SNI allowlist. Deny-all is implied for anything not listed. */
    allowDomains: string[];
    /** Optional CIDR allowlist for non-DNS destinations. */
    allowCidrs?: string[];
}

/** Result of running a command inside the VM. */
export interface ExecResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}

/**
 * Handle to a long-lived in-VM process whose stdout is consumed
 * incrementally (the `claude` agent process). `stdout` is walked once;
 * `wait` resolves the exit code; `interrupt` is best-effort cancel.
 */
export interface ExecStreamHandle {
    /** stdout chunks, in order. Walked exactly once by the harness. */
    stdout: AsyncIterable<Buffer | string>;
    /** Resolves with the exit code when the process terminates. */
    wait(): Promise<ExecResult>;
    /** Best-effort SIGINT/kill. */
    interrupt(): Promise<void>;
}

/** Opaque handle to a provisioned microVM. */
export interface SandboxHandle {
    id: string;
}

/** A file to push into the VM filesystem. */
export interface SandboxFile {
    /** Absolute in-VM path. */
    path: string;
    /** Base64-encoded file contents. */
    contentBase64: string;
    /** Optional POSIX mode (e.g. 0o755 for an executable). */
    mode?: number;
}

/** Options for {@link SandboxClient.createOrResume}. */
export interface CreateOrResumeOpts {
    /** Base snapshot to fork from (pre-baked image with Node + claude +
     *  the eden-lite daemon). When absent the platform default is used. */
    baseSnapshot?: string;
}

/** Options for {@link SandboxClient.exec}. */
export interface ExecOpts {
    /** Per-command env. The harness NEVER places secrets here — the
     *  backend bearer + Anthropic key are injected at the egress proxy,
     *  not inside the VM. */
    env?: Record<string, string>;
    /** Working directory for the command (e.g. the FUSE mount). */
    cwd?: string;
    /** Run detached (the long-lived FUSE mount, the claude process). */
    detached?: boolean;
}

/**
 * The runtime seam. The concrete Vercel adapter implements this; tests
 * implement an in-memory stub. The harness holds only this interface.
 */
export interface SandboxClient {
    /** Provision a fresh microVM forked from the base snapshot, or
     *  re-attach to the named one for this `key` (idempotent across
     *  turns of the same conversation). */
    createOrResume(key: string, opts: CreateOrResumeOpts): Promise<SandboxHandle>;
    /** Apply the egress firewall (deny-all + allowlist) and credential
     *  brokering. MUST be called BEFORE any agent code runs. */
    setNetworkPolicy(h: SandboxHandle, policy: NetworkPolicy): Promise<void>;
    /** Push files into the VM fs (daemon binary, non-secret env shim). */
    writeFiles(h: SandboxHandle, files: SandboxFile[]): Promise<void>;
    /** Run a command inside the VM to completion (the FUSE mount launch,
     *  health checks). */
    exec(h: SandboxHandle, argv: string[], opts?: ExecOpts): Promise<ExecResult>;
    /** Start a long-lived command and stream its stdout incrementally
     *  (the agent `claude` process). */
    execStream(
        h: SandboxHandle,
        argv: string[],
        opts?: ExecOpts,
    ): Promise<ExecStreamHandle>;
    /** Tear down the sandbox (cancel / end of run). The harness exposes this
     *  as the run's stop handler so a renderer-initiated stop propagates all
     *  the way down to releasing the microVM. */
    stop(h: SandboxHandle): Promise<void>;
}
