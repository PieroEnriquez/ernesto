import { describe, expect, it } from 'vitest';
import { bridgeSettle, type FetchLike } from '../settle-bridge';
import type { VmSettleRequest } from '../wire';

const REQ: VmSettleRequest = {
    workspaces: ['hr'],
    message: 'update policy',
    files: [{ path: 'workspaces/hr/WORKSPACE.md', contentBase64: 'YWJj' }],
};

function stubFetch(
    status: number,
    body: unknown,
    capture?: (url: string, init?: { body?: string }) => void,
): FetchLike {
    return async (url, init) => {
        capture?.(url, init);
        return { status, json: async () => body };
    };
}

describe('bridgeSettle', () => {
    it('POSTs to /ernesto/vm/settle with the request body', async () => {
        let seenUrl = '';
        let seenBody = '';
        const fetch = stubFetch(200, { ok: true, sha: 'abc', pushed: true }, (u, init) => {
            seenUrl = u;
            seenBody = init?.body ?? '';
        });
        await bridgeSettle({
            backendBaseUrl: 'https://api.bitrefill.internal/',
            fetch,
            request: REQ,
        });
        // trailing slash collapsed
        expect(seenUrl).toBe('https://api.bitrefill.internal/ernesto/vm/settle');
        expect(JSON.parse(seenBody)).toEqual(REQ);
    });

    it('returns a success SettleResult verbatim', async () => {
        const res = await bridgeSettle({
            backendBaseUrl: 'https://b.host',
            fetch: stubFetch(200, { ok: true, sha: 'deadbeef', pushed: true }),
            request: REQ,
        });
        expect(res).toEqual({ ok: true, sha: 'deadbeef', pushed: true });
    });

    it('returns lint_failed verbatim (422)', async () => {
        const body = {
            ok: false,
            error: 'lint_failed',
            errors: [{ code: 'scope', message: 'out of scope' }],
        };
        const res = await bridgeSettle({
            backendBaseUrl: 'https://b.host',
            fetch: stubFetch(422, body),
            request: REQ,
        });
        expect(res).toEqual(body);
    });

    it('returns fast_forward_required verbatim (409)', async () => {
        const body = { ok: false, error: 'fast_forward_required', currentSha: 'x' };
        const res = await bridgeSettle({
            backendBaseUrl: 'https://b.host',
            fetch: stubFetch(409, body),
            request: REQ,
        });
        expect(res).toEqual(body);
    });

    it('maps a pre-flight 403/400 into a structured lint_failed (no scope leak)', async () => {
        const res = await bridgeSettle({
            backendBaseUrl: 'https://b.host',
            fetch: stubFetch(403, { ok: false, error: 'user_revoked' }),
            request: REQ,
        });
        // Surfaced as a non-throwing structured failure carrying the
        // gateway error string — the agent never sees a raw 403.
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.error).toBe('lint_failed');
            if (res.error === 'lint_failed') {
                expect(res.errors[0]!.message).toBe('user_revoked');
            }
        }
    });

    it('does not retry — fetch is called exactly once', async () => {
        let calls = 0;
        const fetch: FetchLike = async () => {
            calls++;
            return { status: 500, json: async () => ({ ok: false, error: 'internal_error' }) };
        };
        await bridgeSettle({ backendBaseUrl: 'https://b.host', fetch, request: REQ });
        expect(calls).toBe(1);
    });
});
