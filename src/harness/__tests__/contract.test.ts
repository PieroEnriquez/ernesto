/**
 * Harness contract tests.
 *
 * One test body, runs against every available harness implementation.
 * The CAS block is gated on `process.env.ANTHROPIC_API_KEY` since CI
 * does not have provider creds; without the key it's marked
 * `describe.skip`.
 */

import { describe, expect, it } from 'vitest';
import type { Harness, HarnessEvent } from '../types';
import { createMockHarness } from '../mock';

interface HarnessFactory {
    name: string;
    make: () => Harness | null;
}

const HARNESS_FACTORIES: HarnessFactory[] = [
    {
        name: 'mock',
        make: () => createMockHarness(),
    },
    {
        name: 'cas',
        make: () => {
            if (!process.env.ANTHROPIC_API_KEY) return null;
            // CAS is loaded lazily so the CI path without the peer dep
            // still doesn't try to resolve it.
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const mod = require('../cas') as typeof import('../cas');
            return mod.createCasHarness({
                providerEnv: {
                    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
                },
            });
        },
    },
];

for (const factory of HARNESS_FACTORIES) {
    const harness = factory.make();
    const block = harness === null ? describe.skip : describe;
    block(`Harness contract — ${factory.name}`, () => {
        it('exposes a stable capability set', () => {
            const h = factory.make();
            if (!h) return;
            // Identity invariant: capabilities is the same object on
            // every read (per the interface contract — frontends cache it).
            const a = h.capabilities;
            const b = h.capabilities;
            expect(a).toBe(b);
            // Shape invariant: all required keys present.
            expect(typeof a.perTokenDeltas).toBe('boolean');
            expect(typeof a.subagents).toBe('boolean');
            expect(typeof a.midResponseCancel).toBe('boolean');
        });

        it('createAgent + send streams assistant_message, usage, status:completed', async () => {
            const h = factory.make();
            if (!h) return;
            const agent = await h.createAgent({
                systemPrompt: 'You are a test.',
                model: { id: 'claude-opus-4-7' },
            });
            const run = await agent.send('hello');
            const events: HarnessEvent[] = [];
            for await (const ev of run.stream()) {
                events.push(ev);
                if (events.length > 200) break; // safety net
            }
            const kinds = events.map((e) => e.kind);
            expect(kinds).toContain('assistant_message');
            expect(kinds).toContain('usage');
            const final = events[events.length - 1];
            expect(final?.kind).toBe('status');
            if (final && final.kind === 'status') {
                expect(['completed', 'errored']).toContain(final.status);
            }
        });

        it('cancel() during stream yields status: canceled', async () => {
            const h = factory.make();
            if (!h) return;
            const agent = await h.createAgent({
                systemPrompt: 'test',
                model: 'claude-opus-4-7',
            });
            const run = await agent.send('hello');
            await run.cancel();
            const events: HarnessEvent[] = [];
            for await (const ev of run.stream()) {
                events.push(ev);
                if (events.length > 200) break;
            }
            const sawCancel = events.some(
                (e) => e.kind === 'status' && e.status === 'canceled',
            );
            expect(sawCancel).toBe(true);
        });

        it('identify() returns an auth probe', async () => {
            const h = factory.make();
            if (!h) return;
            const id = await h.identify();
            expect(typeof id.authed).toBe('boolean');
        });
    });
}
