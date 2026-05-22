/**
 * Cursor branch of the `Harness` contract test.
 *
 * Gated on `CURSOR_API_KEY` like the CAS branch is gated on
 * `ANTHROPIC_API_KEY`. Without the key the test is skipped — CI does
 * not have provider creds. With the key, this exercises the
 * end-to-end `Agent.create → send → stream` path through the
 * canonical `Harness` surface.
 *
 * Important: the import of `createCursorHarness` is **lazy** (inside
 * the `make` closure) so the Cursor SDK — which transitively binds to
 * a native sqlite3 module — never resolves on machines without the
 * key. Mirrors the CAS branch's `require('../cas')` pattern in
 * `src/harness/__tests__/contract.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { Harness, HarnessEvent } from '../../types';

const HAS_KEY = Boolean(process.env.CURSOR_API_KEY);
const block = HAS_KEY ? describe : describe.skip;

function makeHarness(): Harness {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index') as typeof import('../index');
    return mod.createCursorHarness({ apiKey: process.env.CURSOR_API_KEY });
}

block('Harness contract — cursor', () => {
    it('exposes a stable capability set', () => {
        const h = makeHarness();
        const a = h.capabilities;
        const b = h.capabilities;
        expect(a).toBe(b);
        expect(typeof a.perTokenDeltas).toBe('boolean');
        expect(typeof a.subagents).toBe('boolean');
        expect(typeof a.midResponseCancel).toBe('boolean');
    });

    it('createAgent + send streams to a terminal status', async () => {
        const h = makeHarness();
        const agent = await h.createAgent({
            systemPrompt: 'You are a test.',
            model: { id: 'composer-latest' },
        });
        const run = await agent.send('hello');
        const events: HarnessEvent[] = [];
        for await (const ev of run.stream()) {
            events.push(ev);
            if (events.length > 200) break;
        }
        const final = events[events.length - 1];
        expect(final?.kind).toBe('status');
        if (final && final.kind === 'status') {
            expect(['completed', 'errored']).toContain(final.status);
        }
    }, 60_000);

    it('identify() returns an auth probe', async () => {
        const h = makeHarness();
        const id = await h.identify();
        expect(typeof id.authed).toBe('boolean');
    });
});
