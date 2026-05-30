import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../../types';
import { buildClaudeArgv, createRemoteVmHarness, isSecretKey } from '../index';
import type {
    CreateOrResumeOpts,
    ExecOpts,
    ExecResult,
    ExecStreamHandle,
    NetworkPolicy,
    SandboxClient,
    SandboxFile,
    SandboxHandle,
} from '../sandbox-client';

/** A recording in-memory SandboxClient — no native deps, no network. */
class StubSandbox implements SandboxClient {
    public order: string[] = [];
    public policy?: NetworkPolicy;
    public createdKey?: string;
    public writtenFiles: SandboxFile[] = [];
    public execCalls: { argv: string[]; opts?: ExecOpts }[] = [];
    public streamCalls: { argv: string[]; opts?: ExecOpts }[] = [];
    public stdoutLines: string[];

    constructor(stdoutLines: string[]) {
        this.stdoutLines = stdoutLines;
    }

    async createOrResume(
        key: string,
        _opts: CreateOrResumeOpts,
    ): Promise<SandboxHandle> {
        this.order.push('createOrResume');
        this.createdKey = key;
        return { id: `sbx-${key}` };
    }
    async setNetworkPolicy(_h: SandboxHandle, policy: NetworkPolicy): Promise<void> {
        this.order.push('setNetworkPolicy');
        this.policy = policy;
    }
    async writeFiles(_h: SandboxHandle, files: SandboxFile[]): Promise<void> {
        this.order.push('writeFiles');
        this.writtenFiles.push(...files);
    }
    async exec(
        _h: SandboxHandle,
        argv: string[],
        opts?: ExecOpts,
    ): Promise<ExecResult> {
        this.order.push('exec');
        this.execCalls.push({ argv, ...(opts ? { opts } : {}) });
        return { exitCode: 0, stdout: '', stderr: '' };
    }
    async execStream(
        _h: SandboxHandle,
        argv: string[],
        opts?: ExecOpts,
    ): Promise<ExecStreamHandle> {
        this.order.push('execStream');
        this.streamCalls.push({ argv, ...(opts ? { opts } : {}) });
        const lines = this.stdoutLines;
        return {
            stdout: (async function* () {
                for (const l of lines) yield l + '\n';
            })(),
            wait: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
            interrupt: async () => {},
        };
    }
    async readFile(): Promise<Buffer> {
        return Buffer.from('');
    }
    async snapshot(): Promise<{ snapshotId: string }> {
        return { snapshotId: 'snap-1' };
    }
    async stop(): Promise<void> {}
}

const RUN_LINES = [
    '{"type":"system","subtype":"init"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}',
    '{"type":"result","subtype":"success","usage":{"input_tokens":5,"output_tokens":2},"total_cost_usd":0.002}',
];

describe('createRemoteVmHarness lifecycle', () => {
    it('applies egress policy BEFORE writing files / mounting / running', async () => {
        const sandbox = new StubSandbox(RUN_LINES);
        const harness = createRemoteVmHarness({
            sandbox,
            backendBaseUrl: 'https://api.bitrefill.internal',
        });
        await harness.createAgent(
            { systemPrompt: 'test', model: 'claude-opus-4-7' },
            { agentId: 'conv-1' },
        );
        // createOrResume → setNetworkPolicy must precede writeFiles + exec.
        expect(sandbox.order[0]).toBe('createOrResume');
        expect(sandbox.order[1]).toBe('setNetworkPolicy');
        const policyIdx = sandbox.order.indexOf('setNetworkPolicy');
        const writeIdx = sandbox.order.indexOf('writeFiles');
        const execIdx = sandbox.order.indexOf('exec');
        expect(policyIdx).toBeLessThan(writeIdx);
        expect(policyIdx).toBeLessThan(execIdx);
    });

    it('keys the sandbox by agentId and applies the deny-all allowlist', async () => {
        const sandbox = new StubSandbox(RUN_LINES);
        const harness = createRemoteVmHarness({
            sandbox,
            backendBaseUrl: 'https://api.bitrefill.internal',
        });
        await harness.createAgent(
            { systemPrompt: 'test', model: 'm' },
            { agentId: 'conv-xyz' },
        );
        expect(sandbox.createdKey).toBe('conv-xyz');
        expect(sandbox.policy?.allowDomains).toEqual([
            'api.bitrefill.internal',
            'api.anthropic.com',
        ]);
    });

    it('runs claude with cwd = the FUSE mount and streams events', async () => {
        const sandbox = new StubSandbox(RUN_LINES);
        const harness = createRemoteVmHarness({
            sandbox,
            backendBaseUrl: 'https://b.host',
        });
        const agent = await harness.createAgent(
            { systemPrompt: 'test', model: 'm' },
            { agentId: 'conv-2' },
        );
        const run = await agent.send('hello');
        const events: HarnessEvent[] = [];
        for await (const ev of run.stream()) {
            events.push(ev);
            if (events.length > 200) break;
        }
        // claude launched with cwd = /workdir
        expect(sandbox.streamCalls[0]!.opts?.cwd).toBe('/workdir');
        expect(sandbox.streamCalls[0]!.argv[0]).toBe('claude');
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain('assistant_message');
        expect(kinds).toContain('usage');
        const last = events[events.length - 1];
        expect(last?.kind).toBe('status');
        expect(last.kind === 'status' && last.status).toBe('completed');
    });

    it('runs the chosen runtime in the VM (cursor swaps the launched binary)', async () => {
        const sandbox = new StubSandbox(RUN_LINES);
        const { cursorVmRuntime } = await import('../runtimes/cursor');
        const harness = createRemoteVmHarness({
            sandbox,
            backendBaseUrl: 'https://b.host',
            runtime: cursorVmRuntime,
        });
        const agent = await harness.createAgent({ systemPrompt: 'test', model: 'm' }, { agentId: 'conv-cursor' });
        await agent.send('hello');
        // Same placement (cwd = mount), different runtime binary — proves the
        // VM is runtime-agnostic, not hardcoded to claude.
        expect(sandbox.streamCalls[0]!.opts?.cwd).toBe('/workdir');
        expect(sandbox.streamCalls[0]!.argv[0]).toBe('cursor-agent');
    });

    it('wait() resolves a completed RunResult with usage + cost', async () => {
        const sandbox = new StubSandbox(RUN_LINES);
        const harness = createRemoteVmHarness({
            sandbox,
            backendBaseUrl: 'https://b.host',
        });
        const agent = await harness.createAgent(
            { systemPrompt: 'test', model: 'm' },
            { agentId: 'conv-3' },
        );
        const run = await agent.send('hi');
        const result = await run.wait();
        expect(result.status).toBe('completed');
        expect(result.usage.inputTokens).toBe(5);
        expect(result.usage.outputTokens).toBe(2);
        expect(result.usage.costUsd).toBe(0.002);
    });

    it('cancel() yields status:canceled', async () => {
        const sandbox = new StubSandbox(RUN_LINES);
        const harness = createRemoteVmHarness({
            sandbox,
            backendBaseUrl: 'https://b.host',
        });
        const agent = await harness.createAgent(
            { systemPrompt: 'test', model: 'm' },
            { agentId: 'conv-4' },
        );
        const run = await agent.send('hi');
        await run.cancel();
        const events: HarnessEvent[] = [];
        for await (const ev of run.stream()) {
            events.push(ev);
            if (events.length > 200) break;
        }
        expect(
            events.some((e) => e.kind === 'status' && e.status === 'canceled'),
        ).toBe(true);
    });

    it('NEVER places a secret into the VM env (brokered egress)', async () => {
        const sandbox = new StubSandbox(RUN_LINES);
        const harness = createRemoteVmHarness({
            sandbox,
            backendBaseUrl: 'https://b.host',
        });
        await harness.createAgent(
            { systemPrompt: 'test', model: 'm' },
            {
                agentId: 'conv-5',
                // A misbehaving caller tries to smuggle a token in.
                env: {
                    ANTHROPIC_API_KEY: 'sk-secret',
                    BACKEND_BEARER_TOKEN: 'bearer-xyz',
                    TERM: 'xterm',
                },
            },
        );
        const mountEnv = sandbox.execCalls[0]!.opts?.env ?? {};
        const serialized = JSON.stringify(mountEnv);
        expect(serialized).not.toContain('sk-secret');
        expect(serialized).not.toContain('bearer-xyz');
        // Non-secret env still threads through.
        expect(mountEnv['TERM']).toBe('xterm');
    });

    it('capabilities: full Bash tier (mcp/customFnTools off, resume on)', () => {
        const harness = createRemoteVmHarness({
            sandbox: new StubSandbox(RUN_LINES),
            backendBaseUrl: 'https://b.host',
        });
        expect(harness.capabilities.mcp).toBe(false);
        expect(harness.capabilities.customFnTools).toBe(false);
        expect(harness.capabilities.resume).toBe(true);
        expect(harness.capabilities.costReporting).toBe(true);
    });
});

describe('buildClaudeArgv', () => {
    it('streams NDJSON and threads model + maxTurns', () => {
        const argv = buildClaudeArgv(
            { systemPrompt: 'x', model: 'claude-opus-4-7', maxTurns: 12 },
            'do the thing',
        );
        expect(argv[0]).toBe('claude');
        expect(argv).toContain('do the thing');
        expect(argv).toContain('stream-json');
        expect(argv).toContain('claude-opus-4-7');
        expect(argv).toContain('12');
    });
});

describe('isSecretKey', () => {
    it('flags credential-shaped keys', () => {
        expect(isSecretKey('ANTHROPIC_API_KEY')).toBe(true);
        expect(isSecretKey('backend_token')).toBe(true);
        expect(isSecretKey('MY_SECRET')).toBe(true);
        expect(isSecretKey('AUTH_HEADER')).toBe(true);
    });
    it('passes ordinary env keys', () => {
        expect(isSecretKey('HOME')).toBe(false);
        expect(isSecretKey('TERM')).toBe(false);
        expect(isSecretKey('XDG_CONFIG_HOME')).toBe(false);
    });
});
