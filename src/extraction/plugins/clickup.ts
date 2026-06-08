/**
 * ClickUp extraction plugin.
 *
 * Fetches tasks, lists, and docs from ClickUp's REST API and shapes them into
 * ExtractionResult entries. Tasks/lists hit v2 (https://api.clickup.com/api/v2);
 * docs require v3 (https://api.clickup.com/api/v3/workspaces/{workspaceId}/docs/...)
 * because ClickUp moved docs to a workspace-scoped v3 namespace — the v2
 * `/doc/{id}` endpoint does not exist. Token is captured by the factory.
 *
 * Target syntax (matches frontmatter convention):
 *   - task:{id}                 → tasks/{id}.json (raw JSON, v2)
 *   - list:{id}                 → lists/{slug}-{id}.json (raw JSON list metadata, v2).
 *                                  `{slug}` is the list's name slugified; the literal
 *                                  list id is appended so the filename is unique even
 *                                  when two lists share a name and the id stays one
 *                                  Grep away. Falls back to bare `lists/{id}.json` if
 *                                  the list has no name.
 *   - doc:{id}                  → docs/{id}/{page-tree…}/{slug}.md per page — sub-pages
 *                                  nest under their parent page's slug so the doc's
 *                                  hierarchy is preserved (markdown, v3, requires
 *                                  workspaceId option).
 *   - doc:{id}:{rootPageId}     → same shape, but pages outside the subtree
 *                                  rooted at {rootPageId} are dropped.
 *   - list-table:{id}           → lists/{slug}-{id}.md (markdown table of tasks, legacy
 *                                  ClickUpListFormat parity; closed tasks older than
 *                                  ~3 months are dropped, v2). Same `{slug}-{id}` shape
 *                                  as `list:` — only the leaf extension differs.
 *   - folder:{id}               → walk every non-archived list + doc under the
 *                                  folder and emit one entry per child (uses v2
 *                                  for the folder and v3 for docs, requires
 *                                  workspaceId).
 *   - space:{id}                → same as folder: but rooted at a space (folder-
 *                                  less lists + every folder's lists/docs +
 *                                  space-level docs), requires workspaceId.
 *
 * Per-request `includePaths` / `excludePaths` filters, when present, apply to
 * the logical path of each discovered child resource (e.g.
 * `/code-quality/list/agent-ops`, `/draft-specifications/doc/spec-1`). Filters
 * run before content fetching, so excluded items don't burn API quota. They are
 * ignored for `task:`, `list:`, `doc:`, and `list-table:` targets — those
 * resolve to a single explicit resource where filtering is meaningless.
 *
 * Failure shape contract:
 *   - 404 → resolve with empty entries (target absent is not a fatal error)
 *   - 429 → exponential backoff, up to 3 retries
 *   - other non-2xx → throw; dispatcher wraps as `fetch_failed`
 */

import {
    defineExtraction,
    type ExtractionContext,
    type ExtractionEntry,
    type ExtractionPlugin,
    type ExtractionRequest,
    type ExtractionResult,
} from '../define-extraction';
import {
    DEFAULT_BACKOFF_BASE_MS,
    DEFAULT_MAX_RETRIES,
    DEFAULT_TIMEOUT_MS,
    fetchWithRetry as httpFetchWithRetry,
    stringifyJson,
} from './_http';

export interface ClickUpPluginOptions {
    token: string;
    baseUrl?: string;
    /**
     * Base URL for the v3 ClickUp API used by doc-related endpoints.
     * Defaults to `https://api.clickup.com/api/v3`.
     */
    baseUrlV3?: string;
    /**
     * Workspace (team) ID required to fetch docs from the v3 API. Optional
     * at construction time so registering the plugin doesn't require it,
     * but `doc:` targets will throw a clear error at fetch time when unset.
     */
    workspaceId?: string;
    timeoutMs?: number;
    maxRetries?: number;
    backoffBaseMs?: number;
    /**
     * Cutoff (in months) for closed tasks rendered by `list-table:` targets.
     * Closed tasks whose `date_closed` (or `date_updated`) is older than
     * `now - closedTaskCutoffMonths` months are excluded. Matches the legacy
     * ClickUpListFormat behaviour. Defaults to 3.
     */
    closedTaskCutoffMonths?: number;
}

type TargetKind = 'task' | 'list' | 'doc' | 'list-table' | 'folder' | 'space';

const DEFAULT_BASE_URL = 'https://api.clickup.com/api/v2';
const DEFAULT_BASE_URL_V3 = 'https://api.clickup.com/api/v3';
const DEFAULT_CLOSED_TASK_CUTOFF_MONTHS = 3;

const CLOSED_STATUS_NAMES = new Set([
    'closed',
    'done',
    'complete',
    'completed',
    'resolved',
    'cancelled',
    'canceled',
    'archived',
]);

interface ClickUpTask {
    id: string;
    custom_id?: string | null;
    name: string;
    status?: { status?: string; type?: string } | null;
    assignees?: { username?: string }[];
    tags?: { name?: string }[];
    priority?: { priority?: string } | null;
    date_created?: string | null;
    date_updated?: string | null;
    date_closed?: string | null;
    url?: string | null;
}

export function clickupPlugin(opts: ClickUpPluginOptions): ExtractionPlugin {
    if (!opts.token || typeof opts.token !== 'string') {
        throw new Error('clickupPlugin: token is required');
    }
    const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const baseUrlV3 = (opts.baseUrlV3 ?? DEFAULT_BASE_URL_V3).replace(/\/+$/, '');
    const workspaceId = opts.workspaceId;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    const backoffBaseMs = opts.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    const closedTaskCutoffMonths =
        opts.closedTaskCutoffMonths ?? DEFAULT_CLOSED_TASK_CUTOFF_MONTHS;
    const token = opts.token;

    return defineExtraction({
        source: 'clickup',
        scope: 'extraction:clickup:read',
        description:
            'Fetch ClickUp tasks, lists, and docs by id. Targets: task:{id}, list:{id}, doc:{id}, doc:{id}:{rootPageId}, list-table:{id}, folder:{id}, space:{id}.',
        fetch: async (req: ExtractionRequest, ctx: ExtractionContext): Promise<ExtractionResult> => {
            const parsed = parseTarget(req.target);
            const fetchedAt = new Date().toISOString();

            if (parsed.kind === 'list-table') {
                const entry = await fetchListTable({
                    id: parsed.id,
                    token,
                    baseUrl,
                    timeoutMs,
                    maxRetries,
                    backoffBaseMs,
                    closedTaskCutoffMonths,
                    log: ctx.log,
                });
                if (!entry) {
                    ctx.log.info('ClickUp target not found', { kind: parsed.kind });
                    return { entries: [], fetchedAt };
                }
                return { entries: [entry], fetchedAt };
            }

            if (parsed.kind === 'doc') {
                if (!workspaceId) {
                    throw new Error(
                        'clickup: workspaceId option required for doc: targets',
                    );
                }
                const entries = await fetchDocPages({
                    docId: parsed.id,
                    workspaceId,
                    rootPageId: parsed.rootPageId,
                    token,
                    baseUrlV3,
                    timeoutMs,
                    maxRetries,
                    backoffBaseMs,
                    log: ctx.log,
                });
                if (entries === 'not_found') {
                    ctx.log.info('ClickUp target not found', { kind: parsed.kind });
                    return { entries: [], fetchedAt };
                }
                return { entries, fetchedAt };
            }

            if (parsed.kind === 'folder' || parsed.kind === 'space') {
                if (!workspaceId) {
                    throw new Error(
                        `clickup: workspaceId option required for ${parsed.kind}: targets`,
                    );
                }
                const walkCtx: WalkContext = {
                    workspaceId,
                    token,
                    baseUrl,
                    baseUrlV3,
                    timeoutMs,
                    maxRetries,
                    backoffBaseMs,
                    log: ctx.log,
                };
                const discovered =
                    parsed.kind === 'folder'
                        ? await discoverFolder(parsed.id, '', walkCtx)
                        : await discoverSpace(parsed.id, walkCtx);
                const filtered = applyPathFilters(discovered, req);
                const entries: ExtractionEntry[] = [];
                for (const item of filtered) {
                    const itemEntries = await emitDiscoveredItem(item, walkCtx);
                    entries.push(...itemEntries);
                }
                return { entries, fetchedAt };
            }

            const endpoint = endpointFor(parsed.kind, parsed.id, baseUrl);
            const response = await fetchWithRetry(endpoint, token, {
                timeoutMs,
                maxRetries,
                backoffBaseMs,
                log: ctx.log,
                kind: parsed.kind,
                id: parsed.id,
            });

            if (response === 'not_found') {
                ctx.log.info('ClickUp target not found', { kind: parsed.kind });
                return { entries: [], fetchedAt };
            }

            const entry = await buildEntry(parsed.kind, parsed.id, response);
            return { entries: [entry], fetchedAt };
        },
    });
}

interface ParsedTarget {
    kind: TargetKind;
    id: string;
    /** Only set for `doc:{id}:{rootPageId}` — restricts to a page subtree. */
    rootPageId?: string;
}

function parseTarget(target: string): ParsedTarget {
    const idx = target.indexOf(':');
    if (idx < 0) {
        throw new Error(
            `clickup: target must look like "task:{id}", "list:{id}", "doc:{id}", "doc:{id}:{rootPageId}", "list-table:{id}", "folder:{id}", or "space:{id}"`,
        );
    }
    const kindRaw = target.slice(0, idx);
    const rest = target.slice(idx + 1).trim();
    if (!rest) {
        throw new Error('clickup: target id is empty');
    }
    if (
        kindRaw !== 'task' &&
        kindRaw !== 'list' &&
        kindRaw !== 'doc' &&
        kindRaw !== 'list-table' &&
        kindRaw !== 'folder' &&
        kindRaw !== 'space'
    ) {
        throw new Error(`clickup: unsupported target kind: ${kindRaw}`);
    }
    if (kindRaw === 'doc') {
        // doc:{id} OR doc:{id}:{rootPageId} — split on the first remaining colon.
        const subIdx = rest.indexOf(':');
        if (subIdx >= 0) {
            const id = rest.slice(0, subIdx).trim();
            const rootPageId = rest.slice(subIdx + 1).trim();
            if (!id) throw new Error('clickup: doc target docId is empty');
            if (!rootPageId) throw new Error('clickup: doc target rootPageId is empty');
            return { kind: 'doc', id, rootPageId };
        }
    }
    return { kind: kindRaw, id: rest };
}

type V2TaskOrListKind = 'task' | 'list';

function endpointFor(kind: V2TaskOrListKind, id: string, baseUrl: string): string {
    const safe = encodeURIComponent(id);
    switch (kind) {
        case 'task':
            return `${baseUrl}/task/${safe}`;
        case 'list':
            return `${baseUrl}/list/${safe}`;
    }
}

interface FetchWithRetryOpts {
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    log: ExtractionContext['log'];
    kind: TargetKind;
    id: string;
}

function fetchWithRetry(
    url: string,
    token: string,
    opts: FetchWithRetryOpts,
): Promise<Response | 'not_found'> {
    return httpFetchWithRetry(url, {
        timeoutMs: opts.timeoutMs,
        maxRetries: opts.maxRetries,
        backoffBaseMs: opts.backoffBaseMs,
        log: opts.log,
        source: 'clickup',
        kind: opts.kind,
        // ClickUp uses the raw token in Authorization (NOT a Bearer prefix).
        headers: {
            Authorization: token,
            Accept: 'application/json',
        },
        authHint: 'token and scopes',
        rateLimitLabel: 'ClickUp',
    });
}

async function buildEntry(
    kind: V2TaskOrListKind,
    id: string,
    response: Response,
): Promise<ExtractionEntry> {
    const payload = (await response.json()) as unknown;
    let path: string;
    if (kind === 'task') {
        path = `tasks/${id}.json`;
    } else {
        const name = typeof (payload as { name?: unknown }).name === 'string'
            ? (payload as { name: string }).name
            : undefined;
        path = `lists/${listPathStem(name, id)}.json`;
    }
    return {
        path,
        content: stringifyJson(payload),
        contentType: 'application/json',
    };
}

interface FetchListTableArgs {
    id: string;
    token: string;
    baseUrl: string;
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    closedTaskCutoffMonths: number;
    log: ExtractionContext['log'];
}

async function fetchListTable(args: FetchListTableArgs): Promise<ExtractionEntry | null> {
    const safe = encodeURIComponent(args.id);

    // 1. Fetch list metadata (for the title).
    const listRes = await fetchWithRetry(`${args.baseUrl}/list/${safe}`, args.token, {
        timeoutMs: args.timeoutMs,
        maxRetries: args.maxRetries,
        backoffBaseMs: args.backoffBaseMs,
        log: args.log,
        kind: 'list-table',
        id: args.id,
    });
    if (listRes === 'not_found') {
        return null;
    }
    const listPayload = (await listRes.json()) as { id?: string; name?: string };
    const listName = typeof listPayload.name === 'string' ? listPayload.name : args.id;

    // 2. Fetch tasks for the list, PAGINATED. ClickUp's `/list/{id}/task` returns
    // ~100 tasks/page with a `last_page` flag — a single call silently truncates a
    // big list to its first page, so walk pages until `last_page` (hard-capped). 404
    // on the tasks endpoint (list exists, no tasks) → empty list. Include subtasks +
    // closed for parity with legacy.
    const tasks: ClickUpTask[] = [];
    for (let page = 0; page <= 200; page++) {
        const tasksRes = await fetchWithRetry(
            `${args.baseUrl}/list/${safe}/task?subtasks=true&include_closed=true&page=${page}`,
            args.token,
            {
                timeoutMs: args.timeoutMs,
                maxRetries: args.maxRetries,
                backoffBaseMs: args.backoffBaseMs,
                log: args.log,
                kind: 'list-table',
                id: args.id,
            },
        );
        if (tasksRes === 'not_found') break;
        const payload = (await tasksRes.json()) as { tasks?: ClickUpTask[]; last_page?: boolean };
        const batch = payload.tasks ?? [];
        tasks.push(...batch);
        if (payload.last_page === true || batch.length === 0) break;
    }

    const cutoffMs = computeClosedCutoffMs(args.closedTaskCutoffMonths);
    const filtered = tasks.filter((t) => !isStaleClosedTask(t, cutoffMs));

    const markdown = renderTaskTable(listName, args.id, filtered);

    return {
        path: `lists/${listPathStem(listName, args.id)}.md`,
        content: markdown,
        contentType: 'text/markdown',
    };
}

function computeClosedCutoffMs(months: number): number {
    if (!Number.isFinite(months) || months <= 0) {
        return 0;
    }
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setMonth(cutoff.getMonth() - months);
    return cutoff.getTime();
}

function isStaleClosedTask(task: ClickUpTask, cutoffMs: number): boolean {
    if (cutoffMs <= 0) return false;
    const statusName = (task.status?.status ?? '').toLowerCase();
    const statusType = task.status?.type;
    const isClosed = statusType === 'closed' || CLOSED_STATUS_NAMES.has(statusName);
    if (!isClosed) return false;

    const tsStr = task.date_closed || task.date_updated;
    if (!tsStr) return false;
    const ts = parseInt(String(tsStr), 10);
    if (!Number.isFinite(ts)) return false;
    return ts < cutoffMs;
}

function renderTaskTable(listName: string, listId: string, tasks: ClickUpTask[]): string {
    const header = `# ${listName}\n\nList ID: ${listId}\n`;

    if (tasks.length === 0) {
        return `${header}\n_No tasks._\n`;
    }

    const columns = [
        'ID',
        'Name',
        'Status',
        'Assignees',
        'Priority',
        'Tags',
        'Updated',
        'URL',
    ];
    const rows: string[] = [];
    rows.push(`| ${columns.join(' | ')} |`);
    rows.push(`| ${columns.map(() => '---').join(' | ')} |`);

    for (const t of tasks) {
        rows.push(
            `| ${[
                escapeCell(t.custom_id || t.id),
                escapeCell(t.name ?? ''),
                escapeCell(t.status?.status ?? ''),
                escapeCell((t.assignees ?? []).map((a) => a.username ?? '').filter(Boolean).join(', ')),
                escapeCell(t.priority?.priority ?? ''),
                escapeCell((t.tags ?? []).map((tag) => tag.name ?? '').filter(Boolean).join(', ')),
                escapeCell(formatTimestamp(t.date_updated)),
                escapeCell(t.url ?? `https://app.clickup.com/t/${t.id}`),
            ].join(' | ')} |`,
        );
    }

    return `${header}\n${rows.join('\n')}\n`;
}

function escapeCell(value: string): string {
    return String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function formatTimestamp(ts: string | null | undefined): string {
    if (!ts) return '';
    const n = parseInt(String(ts), 10);
    if (!Number.isFinite(n)) return '';
    try {
        return new Date(n).toISOString();
    } catch {
        return '';
    }
}

interface ClickUpPageListing {
    id: string;
    doc_id?: string;
    parent_page_id?: string | null;
    workspace_id?: number;
    name: string;
    pages?: ClickUpPageListing[];
}

interface ClickUpPage {
    id: string;
    doc_id?: string;
    name?: string;
    content?: string;
}

interface FetchDocPagesArgs {
    docId: string;
    workspaceId: string;
    /** When set, only pages within the subtree rooted at this page id are emitted. */
    rootPageId?: string;
    token: string;
    baseUrlV3: string;
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    log: ExtractionContext['log'];
}

async function fetchDocPages(
    args: FetchDocPagesArgs,
): Promise<ExtractionEntry[] | 'not_found'> {
    const safeWorkspace = encodeURIComponent(args.workspaceId);
    const safeDoc = encodeURIComponent(args.docId);
    const listingUrl = `${args.baseUrlV3}/workspaces/${safeWorkspace}/docs/${safeDoc}/page_listing`;

    const listingRes = await fetchWithRetry(listingUrl, args.token, {
        timeoutMs: args.timeoutMs,
        maxRetries: args.maxRetries,
        backoffBaseMs: args.backoffBaseMs,
        log: args.log,
        kind: 'doc',
        id: args.docId,
    });
    if (listingRes === 'not_found') {
        return 'not_found';
    }

    const listingPayload = (await listingRes.json()) as
        | ClickUpPageListing[]
        | { pages?: ClickUpPageListing[] };
    const tree: ClickUpPageListing[] = Array.isArray(listingPayload)
        ? listingPayload
        : (listingPayload.pages ?? []);
    const allPages = flattenPageListing(tree);
    const flatPages = args.rootPageId
        ? filterToSubtree(allPages, args.rootPageId)
        : allPages;

    if (flatPages.length === 0) {
        return [];
    }

    // Resolve slug collisions across the whole doc by appending the pageId.
    const slugCounts = new Map<string, number>();
    for (const p of flatPages) {
        const s = slugify(p.name) || p.id;
        slugCounts.set(s, (slugCounts.get(s) ?? 0) + 1);
    }

    // Preserve the doc's PAGE TREE as the extracted folder hierarchy: walk the listing
    // tree carrying each page's ancestor slugs, so a doc groups by section instead of
    // flattening hundreds of pages into one heap. Keyed off the nested `pages` shape
    // (robust whether or not `parent_page_id` is populated).
    const folderById = new Map<string, string>();
    const walkTree = (nodes: ClickUpPageListing[], prefix: string) => {
        for (const n of nodes) {
            folderById.set(n.id, prefix);
            if (n.pages && n.pages.length > 0) {
                const childPrefix = prefix
                    ? `${prefix}/${slugify(n.name) || n.id}`
                    : slugify(n.name) || n.id;
                walkTree(n.pages, childPrefix);
            }
        }
    };
    walkTree(tree, '');

    const entries: ExtractionEntry[] = [];
    for (const page of flatPages) {
        const pageUrl = `${args.baseUrlV3}/workspaces/${safeWorkspace}/docs/${safeDoc}/pages/${encodeURIComponent(page.id)}?content_format=text%2Fmd`;
        const pageRes = await fetchWithRetry(pageUrl, args.token, {
            timeoutMs: args.timeoutMs,
            maxRetries: args.maxRetries,
            backoffBaseMs: args.backoffBaseMs,
            log: args.log,
            kind: 'doc',
            id: page.id,
        });
        if (pageRes === 'not_found') {
            args.log.warn('ClickUp doc page not found, skipping', {
                docId: args.docId,
                pageId: page.id,
            });
            continue;
        }
        const payload = (await pageRes.json()) as ClickUpPage;
        const baseSlug = slugify(page.name) || page.id;
        const slug =
            (slugCounts.get(baseSlug) ?? 0) > 1
                ? `${baseSlug}-${page.id}`
                : baseSlug;
        const content = typeof payload.content === 'string' ? payload.content : '';
        const folders = folderById.get(page.id) ?? '';
        const rel = folders ? `${folders}/${slug}` : slug;
        entries.push({
            path: `docs/${args.docId}/${rel}.md`,
            content,
            contentType: 'text/markdown',
        });
    }

    return entries;
}

function flattenPageListing(
    pages: ClickUpPageListing[],
    acc: ClickUpPageListing[] = [],
): ClickUpPageListing[] {
    for (const p of pages) {
        acc.push(p);
        if (p.pages && p.pages.length > 0) {
            flattenPageListing(p.pages, acc);
        }
    }
    return acc;
}

/**
 * Keep only the page at `rootPageId` and its descendants.
 *
 * Reads `parent_page_id` from the flattened listing to reconstruct the tree.
 * Pages with no parent are top-level; any page whose ancestry chain reaches
 * `rootPageId` survives. The root page itself is included so the subtree has a
 * head. If `rootPageId` doesn't appear in the listing, returns `[]` rather than
 * throwing — matches how missing targets degrade to empty entries elsewhere.
 */
function filterToSubtree(
    pages: ClickUpPageListing[],
    rootPageId: string,
): ClickUpPageListing[] {
    const childrenByParent = new Map<string, ClickUpPageListing[]>();
    for (const p of pages) {
        const parent = p.parent_page_id ?? '';
        const bucket = childrenByParent.get(parent);
        if (bucket) bucket.push(p);
        else childrenByParent.set(parent, [p]);
    }
    const root = pages.find((p) => p.id === rootPageId);
    if (!root) return [];
    const kept: ClickUpPageListing[] = [];
    const queue: string[] = [rootPageId];
    const seen = new Set<string>();
    while (queue.length > 0) {
        const id = queue.shift() as string;
        if (seen.has(id)) continue;
        seen.add(id);
        const page = pages.find((p) => p.id === id);
        if (page) kept.push(page);
        const children = childrenByParent.get(id) ?? [];
        for (const child of children) queue.push(child.id);
    }
    return kept;
}

/**
 * Per-list filename stem: `{slug}-{id}` when the list has a usable
 * name, the raw id otherwise. The id is kept in full — every ClickUp
 * list id is 9–12 digits, so the overhead is small and the audit
 * value of seeing the literal id in the filename is high.
 *
 * On rename in ClickUp the slug part changes; the id suffix survives.
 * Worker writes the new path; the old file becomes an orphan in
 * master-fs until a later GC sweep cleans it.
 */
function listPathStem(name: string | undefined, id: string): string {
    const slug = slugify(name);
    if (!slug) return id;
    return `${slug}-${id}`;
}

function slugify(name: string | undefined): string {
    if (!name) return '';
    return String(name)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s-]+/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
}

// ─── Folder / Space walkers ────────────────────────────────────────────────

interface WalkContext {
    workspaceId: string;
    token: string;
    baseUrl: string;
    baseUrlV3: string;
    timeoutMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    log: ExtractionContext['log'];
}

/**
 * Lightweight discovered-resource record. The walker emits one of these per
 * child (list / doc) under a folder or space, with a logical path used for
 * include/exclude filtering. Content fetching is deferred to `emitDiscoveredItem`
 * so excluded items don't burn API quota.
 */
interface DiscoveredItem {
    kind: 'list' | 'doc';
    id: string;
    name: string;
    logicalPath: string;
}

interface ClickUpListMeta {
    id: string;
    name: string;
    archived?: boolean;
}

interface ClickUpFolderMeta {
    id: string;
    name: string;
    hidden?: boolean;
    archived?: boolean;
    lists?: ClickUpListMeta[];
}

interface ClickUpDocMeta {
    id: string;
    name: string;
}

async function discoverFolder(
    folderId: string,
    basePath: string,
    walkCtx: WalkContext,
    /**
     * Pre-fetched folder metadata, when the caller has it from a parent
     * response. Skips the `/folder/{id}` round-trip — `GET /space/{id}/folder`
     * already returns each folder with its lists embedded, so re-fetching would
     * just burn quota.
     */
    preFetchedFolder?: ClickUpFolderMeta,
): Promise<DiscoveredItem[]> {
    const items: DiscoveredItem[] = [];

    let folder: ClickUpFolderMeta;
    if (preFetchedFolder) {
        folder = preFetchedFolder;
    } else {
        const folderRes = await fetchWithRetry(
            `${walkCtx.baseUrl}/folder/${encodeURIComponent(folderId)}`,
            walkCtx.token,
            {
                timeoutMs: walkCtx.timeoutMs,
                maxRetries: walkCtx.maxRetries,
                backoffBaseMs: walkCtx.backoffBaseMs,
                log: walkCtx.log,
                kind: 'folder',
                id: folderId,
            },
        );
        if (folderRes === 'not_found') {
            walkCtx.log.info('ClickUp folder not found', { folderId });
            return [];
        }
        folder = (await folderRes.json()) as ClickUpFolderMeta;
    }

    for (const list of folder.lists ?? []) {
        if (list.archived) continue;
        items.push({
            kind: 'list',
            id: list.id,
            name: list.name,
            logicalPath: `${basePath}/list/${slugify(list.name) || list.id}`,
        });
    }

    const docs = await listDocsForParent(folderId, walkCtx);
    for (const doc of docs) {
        items.push({
            kind: 'doc',
            id: doc.id,
            name: doc.name,
            logicalPath: `${basePath}/doc/${slugify(doc.name) || doc.id}`,
        });
    }

    return items;
}

async function discoverSpace(
    spaceId: string,
    walkCtx: WalkContext,
): Promise<DiscoveredItem[]> {
    const items: DiscoveredItem[] = [];

    // Folderless lists.
    const listsRes = await fetchWithRetry(
        `${walkCtx.baseUrl}/space/${encodeURIComponent(spaceId)}/list?archived=false`,
        walkCtx.token,
        {
            timeoutMs: walkCtx.timeoutMs,
            maxRetries: walkCtx.maxRetries,
            backoffBaseMs: walkCtx.backoffBaseMs,
            log: walkCtx.log,
            kind: 'space',
            id: spaceId,
        },
    );
    if (listsRes !== 'not_found') {
        const payload = (await listsRes.json()) as { lists?: ClickUpListMeta[] };
        for (const list of payload.lists ?? []) {
            if (list.archived) continue;
            items.push({
                kind: 'list',
                id: list.id,
                name: list.name,
                logicalPath: `/list/${slugify(list.name) || list.id}`,
            });
        }
    }

    // Folders + each folder's lists/docs.
    const foldersRes = await fetchWithRetry(
        `${walkCtx.baseUrl}/space/${encodeURIComponent(spaceId)}/folder?archived=false`,
        walkCtx.token,
        {
            timeoutMs: walkCtx.timeoutMs,
            maxRetries: walkCtx.maxRetries,
            backoffBaseMs: walkCtx.backoffBaseMs,
            log: walkCtx.log,
            kind: 'space',
            id: spaceId,
        },
    );
    if (foldersRes !== 'not_found') {
        const payload = (await foldersRes.json()) as { folders?: ClickUpFolderMeta[] };
        for (const folder of payload.folders ?? []) {
            if (folder.hidden || folder.archived) continue;
            const folderBase = `/${slugify(folder.name) || folder.id}`;
            const folderItems = await discoverFolder(folder.id, folderBase, walkCtx, folder);
            items.push(...folderItems);
        }
    }

    // Space-level docs (not under any folder).
    const docs = await listDocsForParent(spaceId, walkCtx);
    for (const doc of docs) {
        items.push({
            kind: 'doc',
            id: doc.id,
            name: doc.name,
            logicalPath: `/doc/${slugify(doc.name) || doc.id}`,
        });
    }

    return items;
}

/**
 * Paginate `${baseUrlV3}/workspaces/{ws}/docs?parent_id={parentId}` and return
 * non-archived/non-deleted doc metadata. Each page carries `next_cursor` (or
 * `cursor`, depending on the ClickUp release); we walk until empty.
 *
 * Returns an empty array on 404 — the parent may legitimately have no docs.
 */
async function listDocsForParent(
    parentId: string,
    walkCtx: WalkContext,
): Promise<ClickUpDocMeta[]> {
    const collected: ClickUpDocMeta[] = [];
    let cursor: string | undefined;
    const safeWs = encodeURIComponent(walkCtx.workspaceId);

    do {
        const params = new URLSearchParams({
            parent_id: parentId,
            archived: 'false',
            deleted: 'false',
            limit: '100',
        });
        if (cursor) params.set('cursor', cursor);
        const url = `${walkCtx.baseUrlV3}/workspaces/${safeWs}/docs?${params.toString()}`;

        const res = await fetchWithRetry(url, walkCtx.token, {
            timeoutMs: walkCtx.timeoutMs,
            maxRetries: walkCtx.maxRetries,
            backoffBaseMs: walkCtx.backoffBaseMs,
            log: walkCtx.log,
            kind: 'doc',
            id: parentId,
        });
        if (res === 'not_found') return collected;

        const payload = (await res.json()) as {
            docs?: ClickUpDocMeta[];
            next_cursor?: string;
            cursor?: string;
            last_page?: boolean;
        };
        for (const doc of payload.docs ?? []) {
            collected.push({ id: doc.id, name: doc.name });
        }
        const nextCursor = payload.next_cursor ?? payload.cursor;
        if (payload.last_page === true || !nextCursor) break;
        cursor = nextCursor;
    } while (cursor);

    return collected;
}

/**
 * Case-insensitive substring filter. `includePaths` is allow-list (entry kept
 * iff any include substring is present in the logical path). `excludePaths` is
 * deny-list (entry dropped iff any exclude substring matches). Includes are
 * evaluated first; an empty `includePaths` is treated as "match everything",
 * matching the v1 ClickUpSource semantics.
 */
function applyPathFilters(
    items: DiscoveredItem[],
    req: ExtractionRequest,
): DiscoveredItem[] {
    const includes = (req.includePaths ?? []).map((s) => s.toLowerCase()).filter((s) => s.length > 0);
    const excludes = (req.excludePaths ?? []).map((s) => s.toLowerCase()).filter((s) => s.length > 0);
    return items.filter((item) => {
        const lp = item.logicalPath.toLowerCase();
        if (includes.length > 0 && !includes.some((s) => lp.includes(s))) return false;
        if (excludes.length > 0 && excludes.some((s) => lp.includes(s))) return false;
        return true;
    });
}

/**
 * Resolve a discovered child (list or doc) into the same entry shape its
 * corresponding `list:` or `doc:` target would produce.
 */
async function emitDiscoveredItem(
    item: DiscoveredItem,
    walkCtx: WalkContext,
): Promise<ExtractionEntry[]> {
    if (item.kind === 'list') {
        const res = await fetchWithRetry(
            `${walkCtx.baseUrl}/list/${encodeURIComponent(item.id)}`,
            walkCtx.token,
            {
                timeoutMs: walkCtx.timeoutMs,
                maxRetries: walkCtx.maxRetries,
                backoffBaseMs: walkCtx.backoffBaseMs,
                log: walkCtx.log,
                kind: 'list',
                id: item.id,
            },
        );
        if (res === 'not_found') return [];
        const payload = (await res.json()) as unknown;
        return [
            {
                path: `lists/${listPathStem(item.name, item.id)}.json`,
                content: stringifyJson(payload),
                contentType: 'application/json',
            },
        ];
    }
    // doc — walk pages exactly as the `doc:` target does.
    const entries = await fetchDocPages({
        docId: item.id,
        workspaceId: walkCtx.workspaceId,
        token: walkCtx.token,
        baseUrlV3: walkCtx.baseUrlV3,
        timeoutMs: walkCtx.timeoutMs,
        maxRetries: walkCtx.maxRetries,
        backoffBaseMs: walkCtx.backoffBaseMs,
        log: walkCtx.log,
    });
    return entries === 'not_found' ? [] : entries;
}
