import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../event-bus';
import type { FactEvent } from '../types/event';

const makeEvent = (overrides: Partial<FactEvent> = {}): FactEvent => ({
    runId: 'r-1',
    seq: 0,
    type: 'fact.test',
    payload: {},
    ts: 100,
    ...overrides,
});

describe('EventBus', () => {
    it('delivers events to subscribers in order', async () => {
        const bus = new EventBus();
        const received: FactEvent[] = [];
        await bus.subscribe({ onEvent: (e) => received.push(e) });
        bus.emit(makeEvent({ seq: 0 }));
        bus.emit(makeEvent({ seq: 1 }));
        bus.emit(makeEvent({ seq: 2 }));
        expect(received.map((e) => e.seq)).toEqual([0, 1, 2]);
    });

    it('close() removes the listener', async () => {
        const bus = new EventBus();
        const received: FactEvent[] = [];
        const sub = await bus.subscribe({ onEvent: (e) => received.push(e) });
        bus.emit(makeEvent({ seq: 0 }));
        await sub.close();
        bus.emit(makeEvent({ seq: 1 }));
        expect(received.map((e) => e.seq)).toEqual([0]);
    });

    it('routes handler exceptions to onError', async () => {
        const bus = new EventBus();
        const onError = vi.fn();
        await bus.subscribe({
            onEvent: () => {
                throw new Error('boom');
            },
            onError,
        });
        bus.emit(makeEvent());
        expect(onError).toHaveBeenCalledTimes(1);
        expect((onError.mock.calls[0]![0] as Error).message).toBe('boom');
    });

    it('supports multiple subscribers fanned out from one emit', async () => {
        const bus = new EventBus();
        const a: FactEvent[] = [];
        const b: FactEvent[] = [];
        await bus.subscribe({ onEvent: (e) => a.push(e) });
        await bus.subscribe({ onEvent: (e) => b.push(e) });
        bus.emit(makeEvent());
        expect(a.length).toBe(1);
        expect(b.length).toBe(1);
    });
});
