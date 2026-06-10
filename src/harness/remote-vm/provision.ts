/**
 * Provision-spec builder — PURE, unit-tested.
 *
 * Turns the harness env + a per-agent identity into a declarative plan
 * the lifecycle orchestrator executes against the `SandboxClient`:
 *   1. the sandbox key (idempotent provision/resume id),
 *   2. the egress policy to apply FIRST,
 *   3. the (non-secret) files to push,
 *   4. the eden-lite mount command,
 *   5. the claude launch command (cwd = the FUSE mount).
 *
 * CREDENTIAL DISCIPLINE (Build Contract §4/§5): NO secret is ever placed
 * in the VM env. The backend bearer + Anthropic key are injected by the
 * egress proxy on the way out; the VM only carries a non-secret marker so
 * eden-lite + the agent issue plain HTTP to `backendBaseUrl/vm/*` with no
 * token. The per-user scoped principal is threaded to the egress broker
 * via `principal` here — it is metadata for the orchestrator/broker, NOT
 * written into the VM. A `cat /proc/self/environ` inside the VM yields no
 * usable credential.
 */

import type { NetworkPolicy, SandboxFile } from './sandbox-client';
import { buildEgressPolicy } from './egress';

/** The FUSE mount point the agent's cwd is bound to. */
export const WORKDIR_MOUNT = '/workdir';
/** Where the eden-lite daemon binary is staged inside the VM. */
export const EDEN_LITE_PATH = '/opt/eden-lite/index.js';

/** Inputs to {@link buildProvisionSpec}. */
export interface ProvisionInputs {
    /** Stable conversation/agent key — the idempotent sandbox name. */
    agentKey: string;
    /** Backend base URL the in-VM eden-lite + agent talk to. */
    backendBaseUrl: string;
    /** Anthropic model base URL (optional; defaults to public API host). */
    modelBaseUrl?: string;
    /** Pre-built egress policy. When omitted it is derived from the
     *  backend + model base URLs via {@link buildEgressPolicy}. */
    networkPolicy?: NetworkPolicy;
    /** Base snapshot to fork from. */
    baseSnapshot?: string;
    /** The per-user scoped principal id. Threaded to the egress broker
     *  (metadata), NEVER written into the VM env. */
    principal?: string;
    /** Extra non-secret env for the agent process (HOME/XDG only by
     *  default). MUST NOT contain secrets. */
    agentEnv?: Record<string, string>;
}

/** A fully-resolved, declarative provision plan. */
export interface ProvisionSpec {
    /** Idempotent sandbox name passed to `createOrResume`. */
    key: string;
    /** Base snapshot to fork from (may be undefined → platform default). */
    baseSnapshot?: string;
    /** Egress policy applied BEFORE any agent code runs. */
    networkPolicy: NetworkPolicy;
    /** The per-user principal handed to the egress broker (metadata,
     *  never the VM). */
    principal?: string;
    /** Non-secret files to push into the VM (env shim). */
    files: SandboxFile[];
    /** The non-secret env the agent process runs with (HOME/XDG +
     *  the plain backend URL marker — no token). */
    agentEnv: Record<string, string>;
    /** Command to start eden-lite mounting `WORKDIR_MOUNT`. Detached. */
    mountArgv: string[];
    /** Command to launch the agent (claude), cwd = `WORKDIR_MOUNT`. */
    agentCwd: string;
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/**
 * Build the provision plan. Pure — no I/O, no SandboxClient calls. The
 * lifecycle orchestrator (`index.ts`) executes it.
 */
export function buildProvisionSpec(inputs: ProvisionInputs): ProvisionSpec {
    const networkPolicy =
        inputs.networkPolicy ??
        buildEgressPolicy({
            backendBaseUrl: inputs.backendBaseUrl,
            ...(inputs.modelBaseUrl !== undefined ? { modelBaseUrl: inputs.modelBaseUrl } : {}),
        });

    // Non-secret env only. The backend base URL is NOT a secret — the
    // scoped bearer is injected by the egress proxy, not here. We default
    // a minimal HOME/XDG so the agent has a writable home that lives
    // inside the VM (never the mount), and merge any caller-supplied
    // non-secret env on top.
    const agentEnv: Record<string, string> = {
        HOME: '/home/agent',
        XDG_CONFIG_HOME: '/home/agent/.config',
        XDG_CACHE_HOME: '/home/agent/.cache',
        // The plain (token-less) backend URL eden-lite + the agent use.
        ERNESTO_VM_BACKEND_URL: inputs.backendBaseUrl,
        ...(inputs.agentEnv ?? {}),
    };

    // A non-secret shim file documenting the brokered-egress contract.
    // It carries NO token — purely a marker eden-lite reads to find the
    // backend URL, and a breadcrumb for in-VM debugging.
    const shim = [
        '# eden-lite / agent egress shim (NON-SECRET).',
        '# The scoped backend bearer + Anthropic key are injected by the',
        '# egress proxy on the way out. This VM holds NO credential.',
        `ERNESTO_VM_BACKEND_URL=${inputs.backendBaseUrl}`,
        '',
    ].join('\n');

    const files: SandboxFile[] = [{ path: '/etc/eden-lite/egress.env', contentBase64: b64(shim), mode: 0o644 }];

    const mountArgv = ['node', EDEN_LITE_PATH, '--backend-url', inputs.backendBaseUrl, '--mount', WORKDIR_MOUNT];

    return {
        key: inputs.agentKey,
        ...(inputs.baseSnapshot !== undefined ? { baseSnapshot: inputs.baseSnapshot } : {}),
        networkPolicy,
        ...(inputs.principal !== undefined ? { principal: inputs.principal } : {}),
        files,
        agentEnv,
        mountArgv,
        agentCwd: WORKDIR_MOUNT,
    };
}
