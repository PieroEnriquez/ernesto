import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../../types';
import { createTranslatorState, mapVmLine, parseSdkLine } from '../events';
import { splitLines } from '../index';

describe('parseSdkLine', () => {
    it('parses a valid SDK message line', () => {
        const msg = parseSdkLine('{"type":"system","subtype":"init"}');
        expect(msg).not.toBeNull();
        expect(msg!.type).toBe('system');
    });
    it('returns null for blank lines', () => {
        expect(parseSdkLine('')).toBeNull();
        expect(parseSdkLine('   ')).toBeNull();
    });
    it('returns null for non-JSON noise', () => {
        expect(parseSdkLine('starting up...')).toBeNull();
    });
    it('returns null for JSON without a string type', () => {
        expect(parseSdkLine('{"foo":1}')).toBeNull();
        expect(parseSdkLine('42')).toBeNull();
    });
});

describe('mapVmLine', () => {
    it('maps init → status:running once', () => {
        const state = createTranslatorState();
        const ev = mapVmLine(
            '{"type":"system","subtype":"init"}',
            'r1',
            state,
        );
        expect(ev).toEqual([{ kind: 'status', status: 'running', runId: 'r1' }]);
        // second init does not re-emit
        expect(
            mapVmLine('{"type":"system","subtype":"init"}', 'r1', state),
        ).toEqual([]);
    });
    it('drops blank/noise lines without throwing', () => {
        const state = createTranslatorState();
        expect(mapVmLine('', 'r1', state)).toEqual([]);
        expect(mapVmLine('log: booting', 'r1', state)).toEqual([]);
    });
});

async function* chunksOf(...chunks: string[]): AsyncGenerator<string> {
    for (const c of chunks) yield c;
}

async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
    const out: string[] = [];
    for await (const line of gen) out.push(line);
    return out;
}

// `splitLines` (index.ts) is the live splitter feeding `runtime.mapLine`;
// per-line mapping is covered by the `mapVmLine` describe above. Here we
// pin the byte-stream → whole-line behavior: arbitrary chunk boundaries
// and a trailing newline-less line.
describe('splitLines', () => {
    it('yields one whole line per newline-terminated row', async () => {
        const lines = await collect(splitLines(chunksOf('a\nb\nc\n')));
        expect(lines).toEqual(['a', 'b', 'c']);
    });

    it('reassembles a line split mid-token across chunk boundaries', async () => {
        const full =
            '{"type":"system","subtype":"init"}\n' +
            '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n';
        const mid = Math.floor(full.length / 2);
        const lines = await collect(
            splitLines(chunksOf(full.slice(0, mid), full.slice(mid))),
        );
        expect(lines).toEqual([
            '{"type":"system","subtype":"init"}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
        ]);
    });

    it('flushes a trailing partial line with no newline', async () => {
        const lines = await collect(splitLines(chunksOf('{"type":"system"}')));
        expect(lines).toEqual(['{"type":"system"}']);
    });

    it('maps a full run end-to-end when piped through mapVmLine', async () => {
        const full =
            '{"type":"system","subtype":"init"}\n' +
            '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n' +
            '{"type":"result","subtype":"success","usage":{"input_tokens":10,"output_tokens":3},"total_cost_usd":0.001}\n';
        const state = createTranslatorState();
        const events: HarnessEvent[] = [];
        for await (const line of splitLines(chunksOf(full))) {
            events.push(...mapVmLine(line, 'r1', state));
        }
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain('assistant_message');
        expect(kinds).toContain('usage');
        const last = events[events.length - 1];
        expect(last.kind === 'status' && last.status).toBe('completed');
    });
});
