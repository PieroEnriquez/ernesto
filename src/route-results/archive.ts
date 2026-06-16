/**
 * Per-conversation archive of full route results.
 *
 * Why on disk: the agent's tool_result only carries a compact `preview`
 * (cheap inline) plus the workdir-relative `file` path. When the agent
 * needs the full row set on a later turn ("which row has the highest
 * margin?"), it reads the archive via its `Read` tool — no re-query.
 *
 * Path: `<workdir>/workspaces/<workspace>/_results/<isoTs>--<slug>.json`
 * where `workspace` is the part of the URI before `://` and `slug` is
 * the rest with non-safe chars normalized. The `_results/` prefix keeps
 * the archive out of the workspace's content tree (gitignored at the
 * project level; settle skips it).
 *
 * Atomic write (tmp + rename); 10 MB cap (oversize files are truncated
 * with a flag so the agent at least knows something was elided).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

/** Cap per-archive at 10 MB (counted as JSON.stringify(data).length). */
export const ARCHIVE_MAX_BYTES = 10 * 1024 * 1024;

export interface ArchiveLogger {
    info?: (msg: string, meta?: unknown) => void;
    warn?: (msg: string, meta?: unknown) => void;
}

export interface ArchiveRouteResultInput {
    /** Absolute path to the workdir root (workingTreeRoot). */
    workdir: string;
    /** Route URI — used to infer workspace and slug. */
    uri: string;
    /** Validated route params — captured for later debugging / replay. */
    params: Record<string, unknown>;
    /** Run id for cross-referencing with conversation state. */
    runId: string;
    /** The full route response data (pre-strip). */
    data: unknown;
    /** Optional logger; warnings surface oversize truncation. */
    log?: ArchiveLogger;
}

export interface ArchiveFile {
    uri: string;
    params: Record<string, unknown>;
    ts: string;
    runId: string;
    data: unknown;
    /** Set when serialized `data` exceeds ARCHIVE_MAX_BYTES; the on-disk
     *  `data` field is replaced with a stub so the file stays small. */
    truncated?: true;
    originalByteLength?: number;
}

/**
 * Archive the full route response to a workdir-relative JSON file.
 * Returns the workdir-relative path of the written file.
 */
export async function archiveRouteResult(input: ArchiveRouteResultInput): Promise<string> {
    const { workdir, uri, params, runId, data, log } = input;
    const { workspace, slug } = parseRouteUri(uri);
    const ts = new Date().toISOString();
    const fsSafeTs = ts.replace(/[:.]/g, '-').slice(0, -5) + 'Z';
    const filename = `${fsSafeTs}--${slug}.json`;
    const relPath = path.posix.join('workspaces', workspace, '_results', filename);
    const absPath = path.join(workdir, relPath);
    const dirAbs = path.dirname(absPath);

    let payload: ArchiveFile = { uri, params, ts, runId, data };
    const serialized = JSON.stringify(data);
    if (serialized && serialized.length > ARCHIVE_MAX_BYTES) {
        if (log?.warn) {
            log.warn('archiveRouteResult: data exceeded cap; truncating', {
                uri,
                byteLength: serialized.length,
                cap: ARCHIVE_MAX_BYTES,
            });
        }
        payload = {
            uri,
            params,
            ts,
            runId,
            data: {
                __truncated: true,
                note: `route response exceeded archive cap of ${ARCHIVE_MAX_BYTES} bytes; ` + `original was ${serialized.length} bytes`,
            },
            truncated: true,
            originalByteLength: serialized.length,
        };
    }

    await fs.mkdir(dirAbs, { recursive: true });
    const tmpPath = `${absPath}.${process.pid}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    await fs.rename(tmpPath, absPath);
    return relPath;
}

interface ParsedUri {
    workspace: string;
    slug: string;
}

/**
 * Split `scheme://rest` into a filesystem-safe (workspace, slug) pair.
 * Falls back to `unknown` workspace + slugged URI when the input doesn't
 * match the `scheme://path` shape — the archive should never fail just
 * because a route has an unusual URI.
 */
function parseRouteUri(uri: string): ParsedUri {
    const idx = uri.indexOf('://');
    if (idx <= 0) {
        return { workspace: 'unknown', slug: sanitize(uri) || 'route' };
    }
    const workspace = sanitize(uri.slice(0, idx)) || 'unknown';
    const rest = uri.slice(idx + 3);
    const slug = sanitize(rest) || 'route';
    return { workspace, slug };
}

function sanitize(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
}
