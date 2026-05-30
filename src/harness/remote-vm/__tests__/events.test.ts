import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '../../types';
import {
    createTranslatorState,
    mapVmLine,
    mapVmStdout,
    parseSdkLine,
} from '../events';

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

describe('mapVmStdout', () => {
    it('emits assistant_message + usage + status:completed across a full run', async () => {
        const lines = [
            '{"type":"system","subtype":"init"}',
            '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
            '{"type":"result","subtype":"success","usage":{"input_tokens":10,"output_tokens":3},"total_cost_usd":0.001}',
        ];
        const events: HarnessEvent[] = [];
        for await (const ev of mapVmStdout(chunksOf(lines.join('\n')), 'r1')) {
            events.push(ev);
        }
        const kinds = events.map((e) => e.kind);
        expect(kinds).toContain('assistant_message');
        expect(kinds).toContain('usage');
        expect(kinds[kinds.length - 1]).toBe('status');
        const last = events[events.length - 1];
        expect(last.kind === 'status' && last.status).toBe('completed');
    });

    it('reassembles lines split across arbitrary chunk boundaries', async () => {
        // Same three rows, but cut mid-token across chunks.
        const full =
            '{"type":"system","subtype":"init"}\n' +
            '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}\n' +
            '{"type":"result","subtype":"success","usage":{"input_tokens":1,"output_tokens":1}}\n';
        const mid = Math.floor(full.length / 2);
        const events: HarnessEvent[] = [];
        for await (const ev of mapVmStdout(
            chunksOf(full.slice(0, mid), full.slice(mid)),
            'r1',
        )) {
            events.push(ev);
        }
        expect(events.map((e) => e.kind)).toContain('assistant_message');
        expect(events.map((e) => e.kind)).toContain('status');
    });

    it('flushes a trailing partial line with no newline', async () => {
        const events: HarnessEvent[] = [];
        for await (const ev of mapVmStdout(
            chunksOf('{"type":"system","subtype":"init"}'),
            'r1',
        )) {
            events.push(ev);
        }
        expect(events).toEqual([
            { kind: 'status', status: 'running', runId: 'r1' },
        ]);
    });

    it('surfaces a tool_call from an assistant tool_use block', async () => {
        const line =
            '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]}}';
        const events: HarnessEvent[] = [];
        for await (const ev of mapVmStdout(chunksOf(line), 'r1')) {
            events.push(ev);
        }
        const toolCall = events.find((e) => e.kind === 'tool_call');
        expect(toolCall).toMatchObject({
            kind: 'tool_call',
            toolUseId: 't1',
            name: 'Bash',
        });
    });
});
