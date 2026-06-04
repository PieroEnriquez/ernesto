/**
 * remote-vm harness — Vercel-Sandbox microVM agent-execution layer.
 *
 * Structural twin of `harness/cas`: `createRemoteVmHarness(env)` returns a
 * canonical `Harness` (`{ capabilities, createAgent, listModels,
 * identify }`). All VM lifecycle is delegated to the small `SandboxClient`
 * seam; the concrete Vercel-SDK client is the backend's
 * `ernesto/vm/sandbox/vercel-sandbox-client.ts` (the lib owns only the
 * interface — no cloud SDK, no native dep). The harness logic —
 * egress-policy build, provision-spec build, the SDK-message →
 * `HarnessEvent` mapping, lifecycle orchestration — is unit-tested against
 * an in-memory `SandboxClient` stub. (Settle is NOT a harness concern: the
 * in-VM agent settles via eden-lite's control server, which ships the
 * write-overlay to the gateway's `/vm/settle` — see `ernesto/vm`.)
 *
 * Security model (Build Contract §4/§5):
 *   - The microVM + a deny-all egress allowlist (exactly the backend API
 *     host + the Anthropic endpoint) is the boundary. There is no
 *     master-FS volume in the VM; the ONLY door is the scope-gated
 *     `/vm/*` gateway.
 *   - Credentials NEVER enter the VM. The per-user scoped bearer
 *     (backend) and the Anthropic key are injected by the egress proxy
 *     on the way out; the VM env carries a non-secret marker only. The
 *     harness threads the per-user `principal` to the broker (metadata),
 *     never into `writeFiles`/`exec` env.
 */

import { randomUUID } from 'crypto';
import debug from 'debug';
import type {
    AgentDefinition,
    AgentHandle,
    CreateOptions,
    Harness,
    HarnessCapabilities,
    ModelInfo,
    RunHandle,
    RunResult,
    SendOptions,
    UserMessage,
} from '../types';
import { makeRunHandle } from '../run-handle';
import type { NetworkPolicy, SandboxClient, SandboxHandle } from './sandbox-client';
import { buildProvisionSpec, type ProvisionSpec } from './provision';
import type { VmRuntime } from './runtime';
import { claudeVmRuntime } from './runtimes/claude';

const log = debug('ernesto:harness:remote-vm');

export type {
    SandboxClient, SandboxHandle, NetworkPolicy,
    SandboxFile, ExecOpts, ExecResult, ExecStreamHandle, CreateOrResumeOpts,
} from './sandbox-client';
export type { ProvisionSpec, ProvisionInputs } from './provision';
export { buildProvisionSpec, WORKDIR_MOUNT, EDEN_LITE_PATH } from './provision';
export { buildEgressPolicy, hostOf } from './egress';
export { mapVmLine, parseSdkLine } from './events';
// Runtime axis (orthogonal to the VM placement): the VM harness runs ANY
// process-based runtime, defaulting to claude (cas). Swap `runtime` to run
// cursor-agent in the VM with no other change.
export type { VmRuntime } from './runtime';
export { claudeVmRuntime, buildClaudeArgv, CLAUDE_VM_DRIVER_PATH, CLAUDE_VM_DRIVER_SOURCE } from './runtimes/claude';
export { cursorVmRuntime, buildCursorArgv } from './runtimes/cursor';

/** Construction-time env for the remote-vm harness. */
export interface RemoteVmHarnessEnv {
    /** The VM-platform seam. Vercel adapter in prod, stub in tests. */
    sandbox: SandboxClient;
    /** Scoped backend base URL the in-VM eden-lite + agent talk to. */
    backendBaseUrl: string;
    /** Anthropic model base URL (optional; defaults to public API host).
     *  Used only to derive the egress allowlist when `networkPolicy` is
     *  not supplied — the key itself is brokered, never threaded here. */
    modelBaseUrl?: string;
    /** Pre-built egress allowlist. When omitted it is derived from the
     *  backend + model base URLs (exactly two hosts). */
    networkPolicy?: NetworkPolicy;
    /** Base snapshot (Node + claude + eden-lite pre-baked). */
    baseSnapshot?: string;
    /** Which agent runtime runs inside the VM. Defaults to `claudeVmRuntime`
     *  (cas). Pass `cursorVmRuntime` to run cursor-agent in the VM instead —
     *  the placement (provision/mount/stream) is identical. */
    runtime?: VmRuntime;
    /** Override capabilities (test seam / spike tuning). */
    capabilities?: Partial<HarnessCapabilities>;
}

/** Default capability matrix — tuned per the Build Contract §3 note
 *  ("resume:true, mcp:false (full Bash instead), pause:false,
 *  perTokenDeltas:true, costReporting:true"). Adjust from the spike. */
const REMOTE_VM_CAPABILITIES: HarnessCapabilities = {
    perTokenDeltas: true,
    steer: false,
    pause: false,
    hitl: false,
    subagents: true,
    customFnTools: false, // full Bash + native tools instead of fn tools
    mcp: false,
    multiProvider: false,
    listMessages: false,
    listAgents: false,
    resume: true,
    attachments: false,
    costReporting: true,
    midResponseCancel: true,
    nativeStructuredOutput: true,
};

/**
 * Build a `Harness` backed by an isolated microVM + eden-lite FUSE
 * gateway. Pure orchestration over the injected `SandboxClient`.
 */
export function createRemoteVmHarness(env: RemoteVmHarnessEnv): Harness {
    const capabilities: HarnessCapabilities = {
        ...REMOTE_VM_CAPABILITIES,
        ...(env.capabilities ?? {}),
    };
    // The agent-runtime axis (orthogonal to the VM placement). Default = cas.
    const runtime: VmRuntime = env.runtime ?? claudeVmRuntime;

    const createAgent = async (
        def: AgentDefinition,
        opts: CreateOptions = {},
    ): Promise<AgentHandle> => {
        const agentKey = opts.agentId ?? `remote-vm-${randomUUID()}`;

        // 1. Build the declarative provision plan (pure).
        const spec: ProvisionSpec = buildProvisionSpec({
            agentKey,
            backendBaseUrl: env.backendBaseUrl,
            ...(env.modelBaseUrl !== undefined ? { modelBaseUrl: env.modelBaseUrl } : {}),
            ...(env.networkPolicy !== undefined ? { networkPolicy: env.networkPolicy } : {}),
            ...(env.baseSnapshot !== undefined ? { baseSnapshot: env.baseSnapshot } : {}),
            // The per-user principal is the brokered identity; it is
            // metadata for the egress broker, never written into the VM.
            ...(opts.env?.['ERNESTO_PRINCIPAL'] !== undefined
                ? { principal: opts.env['ERNESTO_PRINCIPAL'] }
                : {}),
            // Only NON-SECRET env reaches the VM. The caller MUST NOT put
            // tokens in `opts.env`; the egress proxy holds the real creds.
            ...(opts.env !== undefined ? { agentEnv: sanitizeEnv(opts.env) } : {}),
        });

        // 2. Provision-or-resume the named sandbox (idempotent).
        const handle = await env.sandbox.createOrResume(spec.key, {
            ...(spec.baseSnapshot !== undefined ? { baseSnapshot: spec.baseSnapshot } : {}),
        });

        // 3. Apply the egress firewall FIRST — before any agent code runs.
        await env.sandbox.setNetworkPolicy(handle, spec.networkPolicy);

        // 4. Push the non-secret shim files.
        if (spec.files.length > 0) {
            await env.sandbox.writeFiles(handle, spec.files);
        }

        // 5. Start eden-lite mounting the workdir (detached).
        await env.sandbox.exec(handle, spec.mountArgv, {
            env: spec.agentEnv,
            detached: true,
        });

        log('remote-vm agent provisioned', { agentKey, sandboxId: handle.id });

        return makeRemoteVmAgentHandle({
            sandbox: env.sandbox,
            handle,
            spec,
            def,
            runtime,
        });
    };

    const resumeAgent = async (agentId: string): Promise<AgentHandle> => {
        // Re-attach is just createAgent with a fixed key against a
        // resumed sandbox — the snapshot restores the warm FUSE mount.
        return createAgent(
            { systemPrompt: { type: 'preset', preset: 'claude_code' }, model: '' },
            { agentId },
        );
    };

    const listModels = async (): Promise<ModelInfo[]> => {
        // Like cas: no discovery API; the caller knows its model lineup.
        return [];
    };

    const identify = async (): Promise<{ authed: boolean; principal?: string }> => {
        // The VM holds no creds (brokered egress). "Authed" here means the
        // sandbox seam is wired — credential validity is the proxy's job.
        return { authed: Boolean(env.sandbox) };
    };

    return {
        capabilities,
        createAgent,
        resumeAgent,
        listModels,
        identify,
    };
}

/** Inputs to {@link makeRemoteVmAgentHandle}. */
interface AgentHandleInputs {
    sandbox: SandboxClient;
    handle: SandboxHandle;
    spec: ProvisionSpec;
    def: AgentDefinition;
    runtime: VmRuntime;
}

/**
 * Build the `AgentHandle`. `send` launches the in-VM `claude` process
 * with cwd = the FUSE mount, streams its stdout NDJSON through the
 * canonical event mapper, and wraps it in the shared `RunHandle` state
 * machine.
 */
function makeRemoteVmAgentHandle(inputs: AgentHandleInputs): AgentHandle {
    const { sandbox, handle, spec, def, runtime } = inputs;

    const send = async (
        msg: UserMessage,
        sendOpts: SendOptions = {},
    ): Promise<RunHandle> => {
        const prompt = typeof msg === 'string' ? msg : msg.text;
        const runId = sendOpts.runId ?? `run-${randomUUID()}`;

        const argv = runtime.buildArgv(def, prompt);
        const exec = await sandbox.execStream(handle, argv, {
            env: spec.agentEnv,
            cwd: spec.agentCwd,
        });

        return makeRunHandle<string>({
            runId,
            // The platform stdout is split into whole NDJSON lines here; the
            // base's per-message row mapper is the runtime's per-line
            // translator (claude/cursor share the shape). A trailing partial
            // line (no newline) is flushed as a final row.
            source: splitLines(exec.stdout),
            createState: () => runtime.createState(),
            mapMessage: (line, id, state) => runtime.mapLine(line, id, state),
            cancel: () => exec.interrupt(),
            mapResult: (fold): RunResult => {
                const result: RunResult = {
                    runId: fold.runId,
                    status: fold.status,
                    finalAssistant: fold.finalAssistant,
                    usage: fold.usage,
                    durationMs: fold.durationMs,
                };
                if (fold.errorMessage) {
                    result.error = { message: fold.errorMessage };
                }
                return result;
            },
        });
    };

    // Teardown registered by the harness: release the microVM. Reached when
    // a renderer-initiated stop aborts the run (the agent-handler calls
    // `agent.stop()` on the abort signal). Idempotent — stopping an
    // already-stopped sandbox is a no-op the client swallows. A normal
    // turn completion does NOT call this, so the VM stays warm for resume.
    const stop = async (): Promise<void> => {
        await sandbox.stop(handle);
    };

    return { id: handle.id, send, stop };
}

/**
 * Split a stream of stdout chunks (Buffers/strings, arbitrary
 * boundaries) into whole NDJSON lines, carrying a partial trailing line
 * across chunks and flushing it at end-of-stream. Pure + lazy.
 */
export async function* splitLines(
    stdout: AsyncIterable<Buffer | string>,
): AsyncGenerator<string> {
    let buf = '';
    for await (const chunk of stdout) {
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let nl = buf.indexOf('\n');
        while (nl !== -1) {
            yield buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            nl = buf.indexOf('\n');
        }
    }
    if (buf.length > 0) yield buf;
}

/**
 * Drop any plausibly-secret keys before they reach the VM env. The
 * brokered-egress model means the VM must never carry a bearer/API key;
 * this is a defense-in-depth filter on top of the caller's discipline.
 */
function sanitizeEnv(env: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env)) {
        if (isSecretKey(k)) continue;
        out[k] = v;
    }
    return out;
}

/** Heuristic secret-key matcher (uppercased substring match). */
export function isSecretKey(key: string): boolean {
    const u = key.toUpperCase();
    return (
        u.includes('TOKEN') ||
        u.includes('SECRET') ||
        u.includes('KEY') ||
        u.includes('PASSWORD') ||
        u.includes('BEARER') ||
        u.includes('CREDENTIAL') ||
        u.includes('AUTH')
    );
}
