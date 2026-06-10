import { describe, it, expect, vi } from 'vitest';
import { defineExtraction } from '../define-extraction';
import type { ExtractionContext, ExtractionRequest, ExtractionResult } from '../define-extraction';
import { ExtractionRegistry } from '../extraction-registry';
import { dispatchExtraction } from '../dispatch';

const makeCtx = (scopes: Iterable<string>): ExtractionContext => ({
    user: { id: 'u1' },
    scopes: new Set(scopes),
    log: { info: () => {}, warn: () => {}, error: () => {} },
});

const fixedNow = '2026-01-01T00:00:00.000Z';

const echoPlugin = defineExtraction({
    source: 'clickup',
    scope: 'clickup:read',
    fetch: async (req) => ({
        entries: [
            {
                path: `${req.target}.md`,
                content: `# ${req.target}`,
                contentType: 'text/markdown',
            },
        ],
        fetchedAt: fixedNow,
    }),
});

const validRequest: ExtractionRequest = { target: 'list:12345' };

describe('dispatchExtraction', () => {
    it('returns ok with the plugin payload on happy path', async () => {
        const reg = new ExtractionRegistry();
        reg.register(echoPlugin);

        const result = await dispatchExtraction(reg, 'clickup', validRequest, makeCtx(['clickup:read']));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.data.entries).toEqual([{ path: 'list:12345.md', content: '# list:12345', contentType: 'text/markdown' }]);
        expect(result.data.fetchedAt).toBe(fixedNow);
    });

    it('returns source_not_found for unknown sources', async () => {
        const reg = new ExtractionRegistry();
        const result = await dispatchExtraction(reg, 'nope', validRequest, makeCtx([]));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('source_not_found');
        expect(result.details).toEqual({ source: 'nope' });
    });

    it('returns scope_denied with required + missing when scopes are insufficient', async () => {
        const reg = new ExtractionRegistry();
        reg.register(echoPlugin);

        const result = await dispatchExtraction(reg, 'clickup', validRequest, makeCtx([]));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('scope_denied');
        expect(result.details).toMatchObject({
            required: ['clickup:read'],
            missing: ['clickup:read'],
            missingCount: 1,
        });
    });

    it('bypasses scope check when principal holds ernesto:agent-ops', async () => {
        const reg = new ExtractionRegistry();
        reg.register(echoPlugin);

        const result = await dispatchExtraction(reg, 'clickup', validRequest, makeCtx(['ernesto:agent-ops']));
        expect(result.ok).toBe(true);
    });

    it('returns invalid_request when target is empty', async () => {
        const reg = new ExtractionRegistry();
        reg.register(echoPlugin);

        const result = await dispatchExtraction(reg, 'clickup', { target: '' }, makeCtx(['clickup:read']));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('invalid_request');
        expect(result.details).toMatchObject({ field: 'target' });
    });

    it('returns fetch_failed with message only (no stack) when plugin throws', async () => {
        const reg = new ExtractionRegistry();
        reg.register(
            defineExtraction({
                source: 'boom',
                scope: 'x:read',
                fetch: async () => {
                    throw new Error('kaboom');
                },
            }),
        );

        const result = await dispatchExtraction(reg, 'boom', { target: 't' }, makeCtx(['x:read']));
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('fetch_failed');
        expect(result.details).toEqual({ message: 'kaboom' });
        expect(JSON.stringify(result.details)).not.toMatch(/at .*\.ts:/);
    });

    it('returns fetch_failed and logs loudly when plugin returns malformed entries', async () => {
        const reg = new ExtractionRegistry();
        reg.register(
            defineExtraction({
                source: 'liar',
                scope: 'x:read',
                fetch: async () => ({ entries: 'not-an-array', fetchedAt: fixedNow }) as unknown as ExtractionResult,
            }),
        );

        const errLog = vi.fn();
        const ctx: ExtractionContext = {
            ...makeCtx(['x:read']),
            log: { info: () => {}, warn: () => {}, error: errLog },
        };

        const result = await dispatchExtraction(reg, 'liar', { target: 't' }, ctx);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toBe('fetch_failed');
        expect(result.details).toEqual({ message: 'plugin returned malformed result' });
        expect(errLog).toHaveBeenCalledOnce();
        expect(errLog.mock.calls[0][0]).toMatch(/malformed result/);
    });
});
