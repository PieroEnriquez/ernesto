/**
 * GitHub extraction plugin.
 *
 * Fetches pull requests and commits from GitHub's REST API v3 and renders them
 * as Markdown entries. Token is captured by the factory — the lib's
 * ExtractionContext does not carry credentials, and the token is never logged.
 *
 * Target syntax:
 *   - `pr:<repo>:<number>`     — single pull request, rendered as Markdown.
 *   - `commit:<repo>:<sha>`    — single commit (full or short sha), rendered as Markdown.
 *   - `prs:<repo>`             — recent merged PRs (paginated list, 30 most recent).
 *   - `commits:<repo>`         — recent commits on the default branch (30 most recent).
 *
 * Each PR yields `prs/{repo}/{number}.md`; each commit yields
 * `commits/{repo}/{shortSha}.md` — the repo is a path segment so the extracted
 * tree groups naturally by repository (e.g. extracted/github/prs/backend/…).
 *
 * Failure shape contract:
 *   - 404 → resolve with empty entries (target absent is not fatal).
 *   - 429 → exponential backoff, up to 3 retries.
 *   - 401/403 → throw with explicit auth-rejected error (token never echoed).
 *   - other non-2xx → throw; dispatcher wraps as `fetch_failed`.
 */

import {
    defineExtraction,
    type ExtractionContext,
    type ExtractionEntry,
    type ExtractionPlugin,
    type ExtractionRequest,
    type ExtractionResult,
} from '../define-extraction';
import { DEFAULT_BACKOFF_BASE_MS, DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT_MS, fetchWithRetry as httpFetchWithRetry } from './_http';

export interface GitHubPluginOptions {
    token: string;
    owner: string;
    baseUrl?: string;
    timeoutMs?: number;
    maxRetries?: number;
    backoffBaseMs?: number;
    /** Number of recent items to fetch for `prs:` and `commits:` targets. */
    listLimit?: number;
}

type TargetKind = 'pr' | 'commit' | 'prs' | 'commits';

interface ParsedTarget {
    kind: TargetKind;
    repo: string;
    /** PR number or commit sha, only present for `pr:` and `commit:`. */
    id?: string;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_LIST_LIMIT = 30;
const GITHUB_ACCEPT = 'application/vnd.github+json';

export function githubPlugin(opts: GitHubPluginOptions): ExtractionPlugin {
    if (!opts.token || typeof opts.token !== 'string') {
        throw new Error('githubPlugin: token is required');
    }
    if (!opts.owner || typeof opts.owner !== 'string') {
        throw new Error('githubPlugin: owner is required');
    }
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const listLimit = opts.listLimit ?? DEFAULT_LIST_LIMIT;
    const owner = opts.owner;
    const token = opts.token;

    return defineExtraction({
        source: 'github',
        scope: 'extraction:github:read',
        description: 'Fetch GitHub PRs and commits. Targets: pr:<repo>:<number>, commit:<repo>:<sha>, prs:<repo>, commits:<repo>.',
        fetch: async (req: ExtractionRequest, ctx: ExtractionContext): Promise<ExtractionResult> => {
            const parsed = parseTarget(req.target);
            const fetchedAt = new Date().toISOString();

            const fetchOpts: FetchWithRetryOpts = {
                timeoutMs,
                maxRetries,
                backoffBaseMs,
                log: ctx.log,
                kind: parsed.kind,
            };

            if (parsed.kind === 'pr') {
                const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(parsed.repo)}/pulls/${encodeURIComponent(parsed.id!)}`;
                const res = await fetchWithRetry(url, token, fetchOpts);
                if (res === 'not_found') {
                    ctx.log.info('GitHub target not found', { kind: 'pr', repo: parsed.repo });
                    return { entries: [], fetchedAt };
                }
                const pr = (await res.json()) as PullRequestPayload;
                return { entries: [renderPrEntry(pr, parsed.repo)], fetchedAt };
            }

            if (parsed.kind === 'commit') {
                const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(parsed.repo)}/commits/${encodeURIComponent(parsed.id!)}`;
                const res = await fetchWithRetry(url, token, fetchOpts);
                if (res === 'not_found') {
                    ctx.log.info('GitHub target not found', { kind: 'commit', repo: parsed.repo });
                    return { entries: [], fetchedAt };
                }
                const commit = (await res.json()) as CommitPayload;
                return { entries: [renderCommitEntry(commit, parsed.repo)], fetchedAt };
            }

            if (parsed.kind === 'prs') {
                // Recent merged PRs: state=closed sorted by created desc, then filter merged.
                const params = new URLSearchParams({
                    state: 'closed',
                    sort: 'created',
                    direction: 'desc',
                    per_page: String(Math.min(listLimit, 100)),
                });
                const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(parsed.repo)}/pulls?${params.toString()}`;
                const res = await fetchWithRetry(url, token, fetchOpts);
                if (res === 'not_found') {
                    ctx.log.info('GitHub target not found', { kind: 'prs', repo: parsed.repo });
                    return { entries: [], fetchedAt };
                }
                const list = (await res.json()) as PullRequestPayload[];
                const merged = list.filter((pr) => Boolean(pr.merged_at)).slice(0, listLimit);
                return {
                    entries: merged.map((pr) => renderPrEntry(pr, parsed.repo)),
                    fetchedAt,
                };
            }

            // commits:<repo>
            const params = new URLSearchParams({
                per_page: String(Math.min(listLimit, 100)),
            });
            const url = `${baseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(parsed.repo)}/commits?${params.toString()}`;
            const res = await fetchWithRetry(url, token, fetchOpts);
            if (res === 'not_found') {
                ctx.log.info('GitHub target not found', { kind: 'commits', repo: parsed.repo });
                return { entries: [], fetchedAt };
            }
            const list = (await res.json()) as CommitPayload[];
            return {
                entries: list.slice(0, listLimit).map((c) => renderCommitEntry(c, parsed.repo)),
                fetchedAt,
            };
        },
    });
}

function parseTarget(target: string): ParsedTarget {
    const parts = target.split(':');
    const kindRaw = parts[0];
    if (kindRaw === 'prs' || kindRaw === 'commits') {
        const repo = parts.slice(1).join(':').trim();
        if (parts.length !== 2 || !repo) {
            throw new Error(`github: target must look like "${kindRaw}:<repo>"`);
        }
        return { kind: kindRaw, repo };
    }
    if (kindRaw === 'pr' || kindRaw === 'commit') {
        if (parts.length < 3) {
            throw new Error(`github: target must look like "${kindRaw}:<repo>:<${kindRaw === 'pr' ? 'number' : 'sha'}>"`);
        }
        const repo = parts[1].trim();
        const id = parts.slice(2).join(':').trim();
        if (!repo || !id) {
            throw new Error(`github: target "${target}" is missing repo or id`);
        }
        if (kindRaw === 'pr' && !/^\d+$/.test(id)) {
            throw new Error(`github: pr target id must be numeric, got "${id}"`);
        }
        return { kind: kindRaw, repo, id };
    }
    throw new Error(`github: unsupported target kind: ${kindRaw}`);
}

interface FetchWithRetryOpts {
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    log: ExtractionContext['log'];
    kind: TargetKind;
}

function fetchWithRetry(url: string, token: string, opts: FetchWithRetryOpts): Promise<Response | 'not_found'> {
    return httpFetchWithRetry(url, {
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        backoffBaseMs: opts.backoffBaseMs,
        log: opts.log,
        source: 'github',
        kind: opts.kind,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: GITHUB_ACCEPT,
            'X-GitHub-Api-Version': '2022-11-28',
        },
        authHint: 'token and scopes',
        rateLimitLabel: 'GitHub',
    });
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** Repo name as a safe single path segment (the extracted tree groups by it). */
function repoSeg(repo: string): string {
    return (
        repo
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '') || 'unknown'
    );
}

interface PullRequestPayload {
    number: number;
    title: string;
    state: string;
    merged?: boolean;
    merged_at?: string | null;
    created_at?: string;
    html_url?: string;
    body?: string | null;
    user?: { login?: string } | null;
    commits?: number;
    additions?: number;
    deletions?: number;
    changed_files?: number;
    labels?: Array<{ name?: string }>;
    requested_reviewers?: Array<{ login?: string }>;
}

interface CommitPayload {
    sha: string;
    html_url?: string;
    commit: {
        message: string;
        author: { name?: string; email?: string; date?: string };
    };
    stats?: { additions?: number; deletions?: number; total?: number };
    files?: Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        changes?: number;
    }>;
}

function renderPrEntry(pr: PullRequestPayload, repo: string): ExtractionEntry {
    const number = pr.number;
    const title = pr.title;
    const state = (pr.state ?? 'unknown').toUpperCase();
    const author = pr.user?.login ?? 'unknown';
    const body = pr.body && pr.body.length > 0 ? pr.body : '(No description provided)';
    const url = pr.html_url ?? '';
    const createdAt = pr.created_at ?? '';
    const mergedAt = pr.merged_at ?? null;
    const merged = Boolean(pr.merged_at) || Boolean(pr.merged);

    const labels = pr.labels && pr.labels.length > 0 ? pr.labels.map((l) => `- ${l.name ?? ''}`).join('\n') : 'No labels';
    const reviewers =
        pr.requested_reviewers && pr.requested_reviewers.length > 0
            ? pr.requested_reviewers.map((r) => `- @${r.login ?? ''}`).join('\n')
            : 'No reviewers requested';

    const content = `# PR #${number}: ${title}

**Author:** @${author}
**State:** ${merged ? 'Merged' : state}
**Created:** ${createdAt}
${mergedAt ? `**Merged:** ${mergedAt}` : ''}

## Description

${body}

## Stats
- **Commits:** ${pr.commits ?? 0}
- **Additions:** ${pr.additions ?? 0}
- **Deletions:** ${pr.deletions ?? 0}
- **Files changed:** ${pr.changed_files ?? 0}

## Labels
${labels}

## Reviewers
${reviewers}

[View on GitHub](${url})
`.trim();

    return {
        path: `prs/${repoSeg(repo)}/${number}.md`,
        content,
        contentType: 'text/markdown',
    };
}

function renderCommitEntry(commit: CommitPayload, repo: string): ExtractionEntry {
    const sha = commit.sha;
    const shortSha = sha.substring(0, 7);
    const author = commit.commit.author?.name ?? 'unknown';
    const email = commit.commit.author?.email ?? '';
    const date = commit.commit.author?.date ?? '';
    const message = commit.commit.message ?? '';
    const url = commit.html_url ?? '';

    const [subject, ...bodyLines] = message.split('\n');
    const body = bodyLines.join('\n').trim();

    const files = commit.files ?? [];
    const filesSummary =
        files.length > 0
            ? files
                  .map((f) => {
                      const status = f.status === 'added' ? '+ ' : f.status === 'removed' ? '- ' : f.status === 'modified' ? 'M ' : '? ';
                      return `${status}${f.filename} (+${f.additions}/-${f.deletions})`;
                  })
                  .join('\n')
            : 'No file changes available';

    const content = `# ${subject}

**Commit:** \`${shortSha}\` ([${sha}](${url}))
**Author:** ${author}${email ? ` <${email}>` : ''}
**Date:** ${date}

## Message

${body || '(No additional details)'}

## Statistics

- **Additions:** ${commit.stats?.additions ?? 0}
- **Deletions:** ${commit.stats?.deletions ?? 0}
- **Total changes:** ${commit.stats?.total ?? 0}
- **Files changed:** ${files.length}

## Files Changed

\`\`\`
${filesSummary}
\`\`\`

[View on GitHub](${url})
`.trim();

    return {
        path: `commits/${repoSeg(repo)}/${shortSha}.md`,
        content,
        contentType: 'text/markdown',
    };
}
