/**
 * fragua-pi branch of the `Harness` contract test.
 *
 * Gated on `ANTHROPIC_API_KEY` (or any provider-specific env key
 * pi-ai recognises). Without a key the test is skipped — CI does not
 * have provider creds. With a key, this exercises the end-to-end
 * `Agent.create → send → stream` path through the canonical `Harness`
 * surface.
 *
 * Important: the import of `createFraguaPiHarness` is **lazy** (inside
 * the `make` closure) so the pi-ai peer dep — which transitively
 * pulls in provider SDKs (Anthropic, OpenAI, Google, Bedrock) and
 * `proxy-agent` — never resolves on machines without the peer or a
 * key. Mirrors the CAS / Cursor branches in `src/harness/__tests__/contract.test.ts`
 * and `src/harness/cursor/__tests__/contract.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { Harness, HarnessEvent } from '../../types';

const HAS_KEY = Boolean(
    process.env.ANTHROPIC_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.OPENROUTER_API_KEY,
);
const block = HAS_KEY ? describe : describe.skip;

function makeHarness(): Harness {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../index') as typeof import('../index');
    return mod.createFraguaPiHarness({
        apiKeys: {
            ...(process.env.ANTHROPIC_API_KEY
                ? { anthropic: process.env.ANTHROPIC_API_KEY }
                : {}),
            ...(process.env.OPENAI_API_KEY
                ? { openai: process.env.OPENAI_API_KEY }
                : {}),
        },
    });
}

block('Harness contract — fragua-pi', () => {
    it('exposes a stable capability set', () => {
        const h = makeHarness();
        const a = h.capabilities;
        const b = h.capabilities;
        expect(a).toBe(b);
        expect(typeof a.perTokenDeltas).toBe('boolean');
        expect(typeof a.subagents).toBe('boolean');
        expect(typeof a.midResponseCancel).toBe('boolean');
        expect(a.multiProvider).toBe(true);
    });

    it('createAgent + send streams to a terminal status', async () => {
        const h = makeHarness();
        const agent = await h.createAgent({
            systemPrompt: 'You are a test. Reply in one short sentence.',
            model: { id: 'anthropic/claude-opus-4-7' },
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
        if (HAS_KEY) expect(id.authed).toBe(true);
    });
});
