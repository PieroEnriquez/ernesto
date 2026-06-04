import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { githubPlugin } from '../github';
import type { ExtractionContext } from '../../define-extraction';

const TOKEN = 'ghp_test_token_secret_value';
const OWNER = 'acme';
const REPO = 'backend';

const makeCtx = (scopes: Iterable<string> = ['extraction:github:read']): ExtractionContext => ({
    user: { id: 'u1' },
    scopes: new Set(scopes),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});

const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });

const emptyResponse = (status: number): Response => new Response(null, { status });

const samplePr = {
    number: 6298,
    title: 'Add dark mode toggle',
    state: 'closed',
    merged: true,
    merged_at: '2026-04-21T15:30:00Z',
    created_at: '2026-04-20T10:00:00Z',
    html_url: 'https://github.com/acme/backend/pull/6298',
    body: 'This PR adds a toggle for dark mode in the settings panel.',
    user: { login: 'johndoe' },
    commits: 3,
    additions: 120,
    deletions: 12,
    changed_files: 8,
    labels: [{ name: 'enhancement' }],
    requested_reviewers: [{ login: 'jane' }],
};

const sampleCommit = {
    sha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    html_url: 'https://github.com/acme/backend/commit/a1b2c3d',
    commit: {
        message: 'Add user authentication\n\nImplemented JWT-based auth.',
        author: { name: 'John Doe', email: 'john@example.com', date: '2026-04-20T10:00:00Z' },
    },
    stats: { additions: 80, deletions: 10, total: 90 },
    files: [
        { filename: 'src/auth.ts', status: 'added', additions: 60, deletions: 0 },
        { filename: 'src/index.ts', status: 'modified', additions: 20, deletions: 10 },
    ],
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('githubPlugin – metadata', () => {
    it('exposes the documented source, scope, and description', () => {
        const plugin = githubPlugin({ token: TOKEN, owner: OWNER });
        expect(plugin.source).toBe('github');
        expect(plugin.scope).toEqual(['extraction:github:read']);
        expect(plugin.description).toMatch(/GitHub/);
    });

    it('throws when constructed without a token', () => {
        expect(() => githubPlugin({ token: '', owner: OWNER })).toThrow(/token is required/);
    });

    it('throws when constructed without an owner', () => {
        expect(() => githubPlugin({ token: TOKEN, owner: '' })).toThrow(/owner is required/);
    });
});

describe('githubPlugin – happy path per target kind', () => {
    it('fetches a single PR and renders prs/{number}.md', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, samplePr));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = githubPlugin({ token: TOKEN, owner: OWNER });
        const result = await plugin.fetch(
            { target: `pr:${REPO}:6298` },
            makeCtx(),
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://api.github.com/repos/acme/backend/pulls/6298');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(headers.Accept).toBe('application/vnd.github+json');

        expect(result.entries).toHaveLength(1);
        const entry = result.entries[0];
        expect(entry.path).toBe('prs/6298.md');
        expect(entry.contentType).toBe('text/markdown');
        expect(entry.content).toMatch(/# PR #6298: Add dark mode toggle/);
        expect(entry.content).toMatch(/\*\*Author:\*\* @johndoe/);
        expect(entry.content).toMatch(/Merged/);
        expect(typeof result.fetchedAt).toBe('string');
    });

    it('fetches a single commit and renders commits/{shortSha}.md', async () => {
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, sampleCommit));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = githubPlugin({ token: TOKEN, owner: OWNER });
        const result = await plugin.fetch(
            { target: `commit:${REPO}:a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0` },
            makeCtx(),
        );

        const [url] = fetchMock.mock.calls[0];
        expect(url).toBe(
            'https://api.github.com/repos/acme/backend/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
        );

        expect(result.entries).toHaveLength(1);
        const entry = result.entries[0];
        expect(entry.path).toBe('commits/a1b2c3d.md');
        expect(entry.contentType).toBe('text/markdown');
        expect(entry.content).toMatch(/# Add user authentication/);
        expect(entry.content).toMatch(/John Doe <john@example.com>/);
        expect(entry.content).toMatch(/src\/auth\.ts/);
    });

    it('fetches recent merged PRs and filters to only merged', async () => {
        const list = [
            samplePr,
            { ...samplePr, number: 6297, merged_at: null }, // closed-not-merged, filtered out
            { ...samplePr, number: 6296, merged_at: '2026-04-19T10:00:00Z' },
        ];
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, list));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = githubPlugin({ token: TOKEN, owner: OWNER });
        const result = await plugin.fetch(
            { target: `prs:${REPO}` },
            makeCtx(),
        );

        const [url] = fetchMock.mock.calls[0];
        expect(url).toMatch(
            /^https:\/\/api\.github\.com\/repos\/acme\/backend\/pulls\?/,
        );
        expect(url).toMatch(/state=closed/);
        expect(url).toMatch(/sort=created/);
        expect(url).toMatch(/direction=desc/);

        expect(result.entries).toHaveLength(2);
        expect(result.entries.map((e) => e.path)).toEqual(['prs/6298.md', 'prs/6296.md']);
    });

    it('fetches recent commits on the default branch', async () => {
        const list = [
            sampleCommit,
            { ...sampleCommit, sha: 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1' },
        ];
        const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, list));
        vi.stubGlobal('fetch', fetchMock);

        const plugin = githubPlugin({ token: TOKEN, owner: OWNER });
        const result = await plugin.fetch(
            { target: `commits:${REPO}` },
            makeCtx(),
        );

        const [url] = fetchMock.mock.calls[0];
        expect(url).toMatch(
            /^https:\/\/api\.github\.com\/repos\/acme\/backend\/commits\?/,
        );

        expect(result.entries).toHaveLength(2);
        expect(result.entries[0].path).toBe('commits/a1b2c3d.md');
        expect(result.entries[1].path).toBe('commits/b2c3d4e.md');
    });
});

describe('githubPlugin – error paths', () => {
    it('throws a clear error on 401 without leaking the token', async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(401));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = githubPlugin({ token: TOKEN, owner: OWNER });
        const err = await plugin
            .fetch({ target: `pr:${REPO}:1` }, ctx)
            .then(
                () => null,
                (e: Error) => e,
            );

        expect(err).toBeInstanceOf(Error);
        expect(err!.message).toMatch(/auth rejected.*401/);
        // Token must never appear in the thrown error or in any log call.
        expect(err!.message).not.toContain(TOKEN);
        for (const fn of [ctx.log.info, ctx.log.warn, ctx.log.error] as Array<ReturnType<typeof vi.fn>>) {
            for (const call of fn.mock.calls) {
                expect(JSON.stringify(call)).not.toContain(TOKEN);
            }
        }
    });

    it('returns empty entries on 404 (target absent is not fatal)', async () => {
        const fetchMock = vi.fn().mockResolvedValue(emptyResponse(404));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = githubPlugin({ token: TOKEN, owner: OWNER });
        const result = await plugin.fetch(
            { target: `pr:${REPO}:9999` },
            ctx,
        );

        expect(result.entries).toEqual([]);
        expect(typeof result.fetchedAt).toBe('string');
        expect(ctx.log.info).toHaveBeenCalledWith(
            'GitHub target not found',
            expect.objectContaining({ kind: 'pr', repo: REPO }),
        );
    });

    it('rejects unsupported target prefixes', async () => {
        const plugin = githubPlugin({ token: TOKEN, owner: OWNER });
        await expect(
            plugin.fetch({ target: 'issue:backend:1' }, makeCtx()),
        ).rejects.toThrow(/unsupported target kind/);
    });

    it('rejects pr target with non-numeric number', async () => {
        const plugin = githubPlugin({ token: TOKEN, owner: OWNER });
        await expect(
            plugin.fetch({ target: 'pr:backend:notanumber' }, makeCtx()),
        ).rejects.toThrow(/pr target id must be numeric/);
    });
});

describe('githubPlugin – 429 retry behaviour', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('retries on 429 with exponential backoff then resolves', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(emptyResponse(429))
            .mockResolvedValueOnce(jsonResponse(200, samplePr));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = githubPlugin({
            token: TOKEN,
            owner: OWNER,
            backoffBaseMs: 500,
            maxRetries: 3,
        });

        const promise = plugin.fetch(
            { target: `pr:${REPO}:6298` },
            ctx,
        );

        await vi.advanceTimersByTimeAsync(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(500);
        const result = await promise;

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(ctx.log.warn).toHaveBeenCalledWith(
            'GitHub rate limited, backing off',
            expect.objectContaining({ attempt: 1, delayMs: 500 }),
        );
        expect(result.entries).toHaveLength(1);
        expect(result.entries[0].path).toBe('prs/6298.md');
    });

    it('uses exponential backoff across multiple 429s (500, 1000, 2000), then gives up', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(emptyResponse(429))
            .mockResolvedValueOnce(emptyResponse(429))
            .mockResolvedValueOnce(emptyResponse(429))
            .mockResolvedValueOnce(emptyResponse(429));
        vi.stubGlobal('fetch', fetchMock);

        const ctx = makeCtx();
        const plugin = githubPlugin({
            token: TOKEN,
            owner: OWNER,
            backoffBaseMs: 500,
            maxRetries: 3,
        });

        const promise = plugin.fetch(
            { target: `pr:${REPO}:6298` },
            ctx,
        );
        // Swallow the rejection now so an unhandled-rejection doesn't fire while we advance timers.
        const settled = promise.then(
            (r) => ({ ok: true as const, r }),
            (e: Error) => ({ ok: false as const, e }),
        );

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(500);
        await vi.advanceTimersByTimeAsync(1000);
        await vi.advanceTimersByTimeAsync(2000);

        const outcome = await settled;
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.e.message).toMatch(/fetch failed with status 429/);
        }

        // 1 initial + 3 retries = 4 attempts.
        expect(fetchMock).toHaveBeenCalledTimes(4);
        const delays = (ctx.log.warn as ReturnType<typeof vi.fn>).mock.calls.map(
            (c) => (c[1] as { delayMs: number }).delayMs,
        );
        expect(delays).toEqual([500, 1000, 2000]);
    });
});
