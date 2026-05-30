/**
 * claude (cas) runtime for the VM placement.
 *
 * Launches the Claude Agent SDK CLI in `--output-format stream-json` mode and
 * maps its NDJSON `SDKMessage` lines via the SAME `cas/events` translator the
 * local cas harness uses — one event table, shared across placements.
 */

import type { AgentDefinition } from '../../types';
import type { VmRuntime } from '../runtime';
import { createTranslatorState, mapVmLine } from '../events';

/**
 * Build the `claude` CLI argv for an in-VM run. Streams SDK messages as
 * NDJSON on stdout so the harness can map them. System prompt + model come
 * from the definition; tools default to full Bash + native.
 */
export function buildClaudeArgv(def: AgentDefinition, prompt: string): string[] {
    const model = typeof def.model === 'string' ? def.model : def.model.id;
    const argv = ['claude', '--print', prompt, '--output-format', 'stream-json', '--verbose'];
    if (model) argv.push('--model', model);
    if (typeof def.maxTurns === 'number') argv.push('--max-turns', String(def.maxTurns));
    return argv;
}

export const claudeVmRuntime: VmRuntime = {
    name: 'claude',
    buildArgv: buildClaudeArgv,
    createState: () => createTranslatorState(),
    mapLine: (line, runId, state) => mapVmLine(line, runId, state as ReturnType<typeof createTranslatorState>),
};
