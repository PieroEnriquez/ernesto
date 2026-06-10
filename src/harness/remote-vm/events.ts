/**
 * remote-vm event mapper — PURE, unit-tested.
 *
 * The agent inside the VM is the SAME Claude Agent SDK the cas harness
 * drives, but here it runs as an out-of-process `claude` and streams its
 * `SDKMessage`s as NDJSON on stdout. So the remote-vm mapper is a thin
 * wrapper: split the byte stream into JSON lines, parse each to a raw
 * SDK-shaped object, and reuse the canonical cas row translator
 * (`mapSdkMessage`) to emit `HarnessEvent`s. There is exactly ONE event-
 * mapping table in the lib; we do not fork it.
 *
 * No SDK runtime is imported — `cas/events` references `SDKMessage` as a
 * type only, so this stays on the tested, native-dep-free path.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { HarnessEvent } from '../types';
import { createTranslatorState, mapSdkMessage, type TranslatorState } from '../cas/events';

export { createTranslatorState };
export type { TranslatorState };

/**
 * Parse one NDJSON line into a raw SDK message. Returns `null` for blank
 * lines and for lines that don't parse to an object (defensive — the
 * agent's stdout may interleave non-JSON log noise; we skip it rather
 * than throw, matching the "ignore unknown rows" contract).
 */
export function parseSdkLine(line: string): SDKMessage | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    if (typeof (parsed as { type?: unknown }).type !== 'string') return null;
    return parsed as SDKMessage;
}

/**
 * Map one parsed NDJSON line → `HarnessEvent[]`, threading the translator
 * state across lines. Blank/non-JSON lines yield no events. Exported for
 * unit testing per-line.
 */
export function mapVmLine(line: string, runId: string, state: TranslatorState): HarnessEvent[] {
    const msg = parseSdkLine(line);
    if (msg === null) return [];
    return mapSdkMessage(msg, runId, state);
}
