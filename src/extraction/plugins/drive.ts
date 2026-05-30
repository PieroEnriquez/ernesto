/**
 * Google Drive extraction plugin.
 *
 * Targets:
 *   - `doc:<fileId>`     — Google Doc, exported as Markdown.
 *   - `sheet:<fileId>`   — Google Sheet, exported as CSV.
 *   - `folder:<folderId>` — Folder, recursively walked; each child doc/sheet
 *     becomes an entry. Nested folders are traversed.
 *   - `pdf:<fileId>`     — PDF binary fetched via `files/{id}?alt=media`.
 *     No in-process PDF parser is bundled (keeps deps light); the raw bytes
 *     are returned as a base64 string with `contentType: 'application/pdf'`
 *     so downstream consumers can decode and parse with whatever PDF library
 *     they choose.
 *   - `docx:<fileId>`    — DOCX exported as Markdown via Drive's `export`
 *     endpoint (`mimeType=text/markdown`). Drive handles conversion server-side.
 *
 * Auth model:
 *   - Authorization: Bearer <accessToken> on every request.
 *   - If a refreshToken is provided and a 401 is observed, the plugin attempts
 *     one refresh against `https://oauth2.googleapis.com/token` and retries the
 *     same request once. Any subsequent 401 (or 401 without a refresh token)
 *     surfaces as a thrown error so the dispatcher reports `fetch_failed`.
 *
 * Network:
 *   - 30s timeout per HTTP call.
 *   - 429 responses are retried with exponential backoff (3 attempts).
 *   - 404 yields zero entries for the affected item (folder children that 404
 *     are simply skipped). At the top level, a 404 returns `entries: []`.
 *
 * Tokens are never logged.
 */

import {
    defineExtraction,
    type ExtractionContext,
    type ExtractionEntry,
    type ExtractionRequest,
    type ExtractionResult,
} from '../define-extraction';
import {
    DEFAULT_BACKOFF_BASE_MS,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT_MS,
    sleep,
} from './_http';

const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// drive keeps its bespoke request pipeline (401 token-refresh loop, body-text
// error shaping, FetchOutcome return type) but shares the default constants and
// the sleep helper with the rest of the HTTP plugins.
const REQUEST_TIMEOUT_MS = DEFAULT_TIMEOUT_MS;
const RATE_LIMIT_RETRIES = DEFAULT_MAX_RETRIES;
const RATE_LIMIT_BASE_DELAY_MS = DEFAULT_BACKOFF_BASE_MS;

const MIME_FOLDER = 'application/vnd.google-apps.folder';
const MIME_DOC = 'application/vnd.google-apps.document';
const MIME_SHEET = 'application/vnd.google-apps.spreadsheet';
const MIME_PDF = 'application/pdf';
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface DriveFileMeta {
    id: string;
    name: string;
    mimeType: string;
}

interface FetchOptions {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    asText?: boolean;
    asBinary?: boolean;
}

interface FetchOk<T> {
    ok: true;
    status: number;
    data: T;
}

interface FetchNotFound {
    ok: false;
    status: 404;
}

type FetchOutcome<T> = FetchOk<T> | FetchNotFound;

interface TokenState {
    accessToken: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    driveId?: string;
}

export interface DrivePluginOptions {
    accessToken: string;
    refreshToken?: string;
    /** Used together with refreshToken for the refresh request body. */
    clientId?: string;
    clientSecret?: string;
    /**
     * Shared Drive ID. When set, list queries scope to this Shared Drive
     * (`corpora=drive&driveId=<id>&includeItemsFromAllDrives=true`) and every
     * call carries `supportsAllDrives=true`, which is required for content
     * stored in a Shared Drive. Items in personal "My Drive" 404 under this
     * config — set per-plugin instance, not per-call.
     */
    driveId?: string;
}

export function drivePlugin(opts: DrivePluginOptions) {
    if (!opts || typeof opts.accessToken !== 'string' || opts.accessToken.length === 0) {
        throw new Error('drivePlugin: accessToken is required');
    }

    return defineExtraction({
        source: 'drive',
        scope: 'extraction:drive:read',
        description: 'Google Drive docs, sheets, and folders (recursive)',
        fetch: async (req, ctx) => fetchDrive(req, ctx, opts),
    });
}

/**
 * Append the Shared-Drive query params to a Drive API URL when a driveId is set.
 *
 *   - `supportsAllDrives=true` is required on every call that touches a file in
 *     a Shared Drive (get / export / list / media).
 *   - `corpora=drive`, `driveId=<id>`, and `includeItemsFromAllDrives=true` are
 *     additionally required on list-style calls so the query scopes to the
 *     correct Shared Drive's corpus. We append them only when the URL is the
 *     bare files endpoint with a query (`?q=…`); for `/files/{id}` and
 *     `/files/{id}/export` only the support flag is needed.
 */
function withSharedDriveParams(url: string, driveId: string | undefined): string {
    if (!driveId) return url;
    const u = new URL(url);
    u.searchParams.set('supportsAllDrives', 'true');
    const isListQuery = u.pathname.endsWith('/files') && u.searchParams.has('q');
    if (isListQuery) {
        u.searchParams.set('corpora', 'drive');
        u.searchParams.set('driveId', driveId);
        u.searchParams.set('includeItemsFromAllDrives', 'true');
    }
    return u.toString();
}

async function fetchDrive(
    req: ExtractionRequest,
    ctx: ExtractionContext,
    opts: DrivePluginOptions,
): Promise<ExtractionResult> {
    const target = parseTarget(req.target);
    const tokens: TokenState = {
        accessToken: opts.accessToken,
        refreshToken: opts.refreshToken,
        clientId: opts.clientId,
        clientSecret: opts.clientSecret,
        driveId: opts.driveId,
    };

    const entries: ExtractionEntry[] = [];
    const seen = new Set<string>();

    if (target.kind === 'doc') {
        const entry = await fetchDocEntry(target.id, tokens, ctx);
        if (entry) entries.push(entry);
    } else if (target.kind === 'sheet') {
        const entry = await fetchSheetEntry(target.id, tokens, ctx);
        if (entry) entries.push(entry);
    } else if (target.kind === 'pdf') {
        const entry = await fetchPdfEntry(target.id, tokens, ctx);
        if (entry) entries.push(entry);
    } else if (target.kind === 'docx') {
        const entry = await fetchDocxEntry(target.id, tokens, ctx);
        if (entry) entries.push(entry);
    } else {
        await walkFolder(target.id, tokens, ctx, entries, seen);
    }

    return {
        entries,
        fetchedAt: new Date().toISOString(),
    };
}

interface ParsedTarget {
    kind: 'doc' | 'sheet' | 'folder' | 'pdf' | 'docx';
    id: string;
}

function parseTarget(target: string): ParsedTarget {
    const colon = target.indexOf(':');
    if (colon <= 0 || colon === target.length - 1) {
        throw new Error(
            `drive: invalid target "${target}" (expected doc:<id>, sheet:<id>, folder:<id>, pdf:<id>, or docx:<id>)`,
        );
    }
    const kind = target.slice(0, colon);
    const id = target.slice(colon + 1);
    if (kind !== 'doc' && kind !== 'sheet' && kind !== 'folder' && kind !== 'pdf' && kind !== 'docx') {
        throw new Error(`drive: unsupported target kind "${kind}"`);
    }
    return { kind, id };
}

async function fetchDocEntry(
    fileId: string,
    tokens: TokenState,
    ctx: ExtractionContext,
): Promise<ExtractionEntry | null> {
    const meta = await fetchMeta(fileId, tokens, ctx);
    if (!meta) return null;

    const url = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/markdown')}`;
    const res = await driveRequest<string>(url, tokens, ctx, { asText: true });
    if (!res.ok) return null;

    return {
        path: `docs/${slugify(meta.name)}.md`,
        content: res.data,
        contentType: 'text/markdown',
    };
}

async function fetchSheetEntry(
    fileId: string,
    tokens: TokenState,
    ctx: ExtractionContext,
): Promise<ExtractionEntry | null> {
    const meta = await fetchMeta(fileId, tokens, ctx);
    if (!meta) return null;

    const url = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/csv')}`;
    const res = await driveRequest<string>(url, tokens, ctx, { asText: true });
    if (!res.ok) return null;

    return {
        path: `sheets/${slugify(meta.name)}.csv`,
        content: res.data,
        contentType: 'text/csv',
    };
}

async function fetchPdfEntry(
    fileId: string,
    tokens: TokenState,
    ctx: ExtractionContext,
): Promise<ExtractionEntry | null> {
    const meta = await fetchMeta(fileId, tokens, ctx);
    if (!meta) return null;

    // alt=media downloads the raw bytes for binary files (PDFs uploaded to Drive,
    // not Google-native types). We don't bundle a PDF parser to keep the lib light;
    // callers receive base64-encoded bytes and can decode/parse with whatever
    // library suits their pipeline.
    const url = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?alt=media`;
    const res = await driveRequest<ArrayBuffer>(url, tokens, ctx, { asBinary: true });
    if (!res.ok) return null;

    const base64 = Buffer.from(res.data).toString('base64');

    return {
        path: `pdfs/${slugify(meta.name)}.pdf`,
        content: base64,
        contentType: 'application/pdf',
    };
}

async function fetchDocxEntry(
    fileId: string,
    tokens: TokenState,
    ctx: ExtractionContext,
): Promise<ExtractionEntry | null> {
    const meta = await fetchMeta(fileId, tokens, ctx);
    if (!meta) return null;

    // Drive's `export` endpoint converts DOCX → markdown server-side, so we
    // avoid pulling mammoth (or any docx parser) into the lib dep tree.
    const url = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent('text/markdown')}`;
    const res = await driveRequest<string>(url, tokens, ctx, { asText: true });
    if (!res.ok) return null;

    return {
        path: `docs/${slugify(meta.name)}.md`,
        content: res.data,
        contentType: 'text/markdown',
    };
}

async function walkFolder(
    folderId: string,
    tokens: TokenState,
    ctx: ExtractionContext,
    out: ExtractionEntry[],
    seen: Set<string>,
): Promise<void> {
    if (seen.has(folderId)) return;
    seen.add(folderId);

    const children = await listFolderChildren(folderId, tokens, ctx);
    if (!children) return;

    for (const child of children) {
        if (seen.has(child.id)) continue;
        if (child.mimeType === MIME_FOLDER) {
            await walkFolder(child.id, tokens, ctx, out, seen);
        } else if (child.mimeType === MIME_DOC) {
            seen.add(child.id);
            const entry = await fetchDocEntry(child.id, tokens, ctx);
            if (entry) out.push(entry);
        } else if (child.mimeType === MIME_SHEET) {
            seen.add(child.id);
            const entry = await fetchSheetEntry(child.id, tokens, ctx);
            if (entry) out.push(entry);
        }
        // other mime types are ignored — drive plugin is doc/sheet/folder only
    }
}

async function listFolderChildren(
    folderId: string,
    tokens: TokenState,
    ctx: ExtractionContext,
): Promise<DriveFileMeta[] | null> {
    const collected: DriveFileMeta[] = [];
    let pageToken: string | undefined;

    do {
        const params = new URLSearchParams({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id,name,mimeType)',
            pageSize: '100',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const url = `${DRIVE_FILES_API}?${params.toString()}`;

        const res = await driveRequest<{ files?: DriveFileMeta[]; nextPageToken?: string }>(
            url,
            tokens,
            ctx,
        );
        if (!res.ok) return null;
        for (const f of res.data.files ?? []) {
            collected.push(f);
        }
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    return collected;
}

async function fetchMeta(
    fileId: string,
    tokens: TokenState,
    ctx: ExtractionContext,
): Promise<DriveFileMeta | null> {
    const url = `${DRIVE_FILES_API}/${encodeURIComponent(fileId)}?fields=id,name,mimeType`;
    const res = await driveRequest<DriveFileMeta>(url, tokens, ctx);
    if (!res.ok) return null;
    return res.data;
}

async function driveRequest<T>(
    url: string,
    tokens: TokenState,
    ctx: ExtractionContext,
    options: FetchOptions = {},
): Promise<FetchOutcome<T>> {
    let refreshed = false;
    const finalUrl = withSharedDriveParams(url, tokens.driveId);

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const response = await doFetchWithRateLimit(finalUrl, tokens.accessToken, ctx, options);

        if (response.status === 404) {
            return { ok: false, status: 404 };
        }

        if (response.status === 401) {
            if (refreshed || !tokens.refreshToken) {
                throw new Error('drive: unauthorized (401)');
            }
            refreshed = true;
            await refreshAccessToken(tokens, ctx);
            continue;
        }

        if (response.status >= 200 && response.status < 300) {
            let data: T;
            if (options.asBinary) {
                data = (await response.arrayBuffer()) as unknown as T;
            } else if (options.asText) {
                data = (await response.text()) as unknown as T;
            } else {
                data = (await response.json()) as T;
            }
            return { ok: true, status: response.status, data };
        }

        const body = await safeReadText(response);
        throw new Error(`drive: request failed (${response.status}) ${truncate(body, 200)}`);
    }
}

async function doFetchWithRateLimit(
    url: string,
    accessToken: string,
    ctx: ExtractionContext,
    options: FetchOptions,
): Promise<Response> {
    let attempt = 0;
    // attempt 0..RATE_LIMIT_RETRIES inclusive — i.e. up to 4 calls total
    // when retries=3. The task says "3 retries"; we treat that as 3 retries
    // after the first attempt.
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await doFetch(url, accessToken, options);
        if (res.status !== 429 || attempt >= RATE_LIMIT_RETRIES) {
            return res;
        }
        const delay = RATE_LIMIT_BASE_DELAY_MS * Math.pow(2, attempt);
        ctx.log.warn('drive: rate limited, backing off', { attempt: attempt + 1, delayMs: delay });
        await sleep(delay);
        attempt += 1;
    }
}

async function doFetch(
    url: string,
    accessToken: string,
    options: FetchOptions,
): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        return await fetch(url, {
            method: options.method ?? 'GET',
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: 'application/json',
                ...(options.headers ?? {}),
            },
            body: options.body,
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }
}

async function refreshAccessToken(tokens: TokenState, ctx: ExtractionContext): Promise<void> {
    if (!tokens.refreshToken) {
        throw new Error('drive: cannot refresh — no refresh token');
    }
    const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
    });
    if (tokens.clientId) body.set('client_id', tokens.clientId);
    if (tokens.clientSecret) body.set('client_secret', tokens.clientSecret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
        res = await fetch(OAUTH_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
            signal: controller.signal,
        });
    } finally {
        clearTimeout(timer);
    }

    if (!res.ok) {
        throw new Error(`drive: token refresh failed (${res.status})`);
    }

    const parsed = (await res.json()) as { access_token?: unknown };
    if (typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
        throw new Error('drive: token refresh response missing access_token');
    }
    tokens.accessToken = parsed.access_token;
    ctx.log.info('drive: access token refreshed');
}

async function safeReadText(res: Response): Promise<string> {
    try {
        return await res.text();
    } catch {
        return '';
    }
}

function truncate(s: string, max: number): string {
    return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function slugify(name: string): string {
    const base = name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return base.length > 0 ? base : 'untitled';
}
