/**
 * eden-lite ↔ gateway wire shapes, as seen from the lib (harness) side.
 *
 * These mirror the canonical shapes in
 * `backend/src/ernesto/vm/{manifest,settle}.ts` (Build Contract §1/§2).
 * They are duplicated here — not imported — because the lib must not
 * depend on the backend package. The backend is the authority; keep the
 * two in sync (the gateway's request validation is the enforcement
 * point, so a drift here can only ever surface as a `400 bad_request`,
 * never a scope leak).
 *
 * The `/vm/settle` RESPONSE is the lib's own `SettleResult` union, so we
 * re-use that type directly rather than re-declaring it.
 */

import type { SettleResult } from '../../workdir';

/** One settle-overlay entry. Exactly one of (`contentBase64` set) |
 *  (`deleted: true`) is meaningful: a write carries bytes, a whiteout
 *  carries `deleted: true`. `path` is tree-relative under
 *  `workspaces/<w>/…`. */
export interface VmSettleFile {
    path: string;
    /** Base64 of the full file contents (whole-file copy-up, not a
     *  patch). Omitted iff `deleted`. */
    contentBase64?: string;
    /** `true` for an overlay whiteout (unlink/rmdir of a tracked file). */
    deleted?: boolean;
}

/** `POST /ernesto/vm/settle` request body. */
export interface VmSettleRequest {
    /** Workspaces this settle may touch — the staging pathspec. Every
     *  `files[].path` must resolve to one of these, and the gateway's
     *  lint independently re-checks write-scope against the principal. */
    workspaces: string[];
    /** Commit message subject (trailers added server-side). */
    message: string;
    /** The write-overlay as a file-set: changed blobs + whiteouts. */
    files: VmSettleFile[];
}

/** `POST /ernesto/vm/settle` response body — the lib's `SettleResult`
 *  union, returned verbatim as JSON. */
export type VmSettleResponse = SettleResult;
