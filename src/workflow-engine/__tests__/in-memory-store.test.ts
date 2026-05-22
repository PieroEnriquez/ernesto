import { describe, it, expect } from 'vitest';
import { InMemoryStore } from '../store/in-memory-store';

describe('InMemoryStore', () => {
    it('appends events with monotonic seq per run', async () => {
        const s = new InMemoryStore();
        const a = await s.appendEvent({
            runId: 'r-1',
            type: 'fact.x',
            writer: 'engine',
            payload: { i: 0 },
            ts: 1,
        });
        const b = await s.appendEvent({
            runId: 'r-1',
            type: 'fact.x',
            writer: 'engine',
            payload: { i: 1 },
            ts: 2,
        });
        expect(a.seq).toBe(0);
        expect(b.seq).toBe(1);
    });

    it('lists events sinceSeq', async () => {
        const s = new InMemoryStore();
        for (let i = 0; i < 5; i++) {
            await s.appendEvent({
                runId: 'r-1',
                type: 'fact.x',
                writer: 'engine',
                payload: { i },
                ts: i,
            });
        }
        const since = await s.listEvents('r-1', { sinceSeq: 2 });
        expect(since.map((e) => e.seq)).toEqual([3, 4]);
    });

    it('put + get run state round-trips', async () => {
        const s = new InMemoryStore();
        await s.putRunState({
            runId: 'r-1',
            workflow: 'wf',
            status: 'running',
            inputs: {},
            routing: { tier: 'A' },
            startedAt: 100,
        });
        const got = await s.getRunState('r-1');
        expect(got?.status).toBe('running');
        expect(got?.routing).toEqual({ tier: 'A' });
    });

    it('listRuns filters by status + applies limit', async () => {
        const s = new InMemoryStore();
        await s.putRunState({
            runId: 'a',
            workflow: 'wf',
            status: 'running',
            inputs: {},
            routing: {},
            startedAt: 1,
        });
        await s.putRunState({
            runId: 'b',
            workflow: 'wf',
            status: 'completed',
            inputs: {},
            routing: {},
            startedAt: 2,
        });
        await s.putRunState({
            runId: 'c',
            workflow: 'wf',
            status: 'completed',
            inputs: {},
            routing: {},
            startedAt: 3,
        });
        const completed = await s.listRuns({ status: 'completed' });
        expect(completed.map((r) => r.runId)).toEqual(['c', 'b']);
        const limited = await s.listRuns({ limit: 1 });
        expect(limited.length).toBe(1);
        expect(limited[0]!.runId).toBe('c');
    });

    it('getRunState returns null when unknown', async () => {
        const s = new InMemoryStore();
        expect(await s.getRunState('nope')).toBeNull();
    });
});
