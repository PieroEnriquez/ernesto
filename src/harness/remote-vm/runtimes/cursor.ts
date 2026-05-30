/**
 * cursor runtime for the VM placement.
 *
 * Launches `cursor-agent` in NDJSON-streaming mode and maps its lines via the
 * SAME `cursor/events` translator the local cursor harness uses. Proves the
 * VM placement is runtime-agnostic: swap `claudeVmRuntime` → `cursorVmRuntime`
 * and the identical lifecycle (provision → mount → stream → HarnessEvent)
 * runs cursor-agent in the VM instead.
 *
 * SPIKE-NOTE: the exact `cursor-agent` streaming flags are pinned during the
 * cursor-in-VM spike (mirrors how `claude` uses `--output-format stream-json`).
 */

import type { AgentDefinition } from '../../types';
import type { VmRuntime } from '../runtime';
import { createTranslatorState, mapCursorMessage } from '../../cursor/events';

export function buildCursorArgv(def: AgentDefinition, prompt: string): string[] {
    const model = typeof def.model === 'string' ? def.model : def.model.id;
    const argv = ['cursor-agent', '--print', prompt, '--output-format', 'stream-json'];
    if (model) argv.push('--model', model);
    return argv;
}

function parseCursorLine(line: string): Record<string, unknown> | null {
    const t = line.trim();
    if (!t) return null;
    let o: unknown;
    try { o = JSON.parse(t); } catch { return null; }
    if (!o || typeof o !== 'object') return null;
    if (typeof (o as { type?: unknown }).type !== 'string') return null;
    return o as Record<string, unknown>;
}

export const cursorVmRuntime: VmRuntime = {
    name: 'cursor',
    buildArgv: buildCursorArgv,
    createState: () => createTranslatorState(),
    mapLine: (line, runId, state) => {
        const msg = parseCursorLine(line);
        return msg ? mapCursorMessage(msg as any, runId, state as ReturnType<typeof createTranslatorState>) : [];
    },
};
