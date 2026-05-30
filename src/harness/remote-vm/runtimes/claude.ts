/**
 * claude (cas) runtime for the VM placement.
 *
 * Runs the SAME thing `cas` runs — the Claude Agent SDK `query()` loop — but
 * inside the VM, via a tiny driver script that prints each `SDKMessage` as an
 * NDJSON line. The harness maps those lines with the SAME `cas/events`
 * translator the local cas harness uses (one event table, shared across
 * placements). We use `query()` (not the bare `claude` CLI) because that's
 * what cas uses and what the live spike proved; it also lets us set
 * cwd/allowedTools/permissionMode explicitly.
 *
 * The driver source + path are exported so the VM platform (backend Vercel
 * sandbox client) can write the file into the VM during bootstrap.
 */

import type { AgentDefinition } from '../../types';
import type { VmRuntime } from '../runtime';
import { createTranslatorState, mapVmLine } from '../events';

/** In-VM path the backend bootstrap writes the driver to. */
export const CLAUDE_VM_DRIVER_PATH = '/opt/vm/claude-driver.mjs';

/** The in-VM driver: runs `query()` with cwd = the FUSE mount (the exec cwd)
 *  and full Bash + native tools, streaming each SDKMessage as NDJSON so the
 *  harness can map it. Shipped into the VM by the sandbox bootstrap. */
export const CLAUDE_VM_DRIVER_SOURCE = `import { query } from '@anthropic-ai/claude-agent-sdk';
const prompt = process.argv[2] || process.env.AGENT_PROMPT || '';
const model = process.argv[3] || process.env.AGENT_MODEL || undefined;
const options = {
  cwd: process.cwd(),
  permissionMode: 'bypassPermissions',
  allowedTools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
  maxTurns: Number(process.env.AGENT_MAX_TURNS || 24),
  ...(model ? { model } : {}),
};
const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
try {
  for await (const msg of query({ prompt, options })) w(msg);
} catch (err) {
  w({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(err && err.message || err) });
  process.exit(1);
}
`;

/** Launch the driver: `node /opt/vm/claude-driver.mjs <prompt> [model]`. */
export function buildClaudeArgv(def: AgentDefinition, prompt: string): string[] {
    const model = typeof def.model === 'string' ? def.model : def.model.id;
    const argv = ['node', CLAUDE_VM_DRIVER_PATH, prompt];
    if (model) argv.push(model);
    return argv;
}

export const claudeVmRuntime: VmRuntime = {
    name: 'claude',
    buildArgv: buildClaudeArgv,
    createState: () => createTranslatorState(),
    mapLine: (line, runId, state) => mapVmLine(line, runId, state as ReturnType<typeof createTranslatorState>),
};
