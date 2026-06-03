/**
 * Content-overlay → unified-diff projection, and its inverse.
 *
 * The durable per-user state is a CONTENT-OVERLAY (full content per touched
 * path); the unified diff is the wire/settle representation (PROJECT.md §3.1).
 * `overlayToDiff` projects a {@link WorkspacePatch} into a `git apply`-able
 * unified diff: each present file is emitted as a full-content add (a
 * `/dev/null → b/<path>` new-file hunk), each tombstone as a full-content
 * delete (`a/<path> → /dev/null`). This form is self-contained — it does not
 * depend on the base bytes — so the projection is a pure function of the patch.
 *
 * `diffToOverlay` is the exact inverse over that representation, giving a
 * lossless content-overlay ↔ diff round trip. (settle itself applies the
 * overlay content directly and lets git 3-way against current main — see
 * `settle-from-overlay.ts`; the diff projection is for the wire and for the
 * round-trip guarantee.)
 */

import type { WorkspacePatch, PatchEntry } from '../workspaces/overlay';

function isDeleted(e: PatchEntry): e is { deleted: true } {
    return (e as { deleted?: true }).deleted === true;
}

/** Split into lines for hunk emission, preserving a trailing-newline marker.
 *  Returns the line array (without separators) and whether the content ends
 *  with a newline. Empty content → no lines. */
function splitLines(content: string): { lines: string[]; endsWithNewline: boolean } {
    if (content === '') return { lines: [], endsWithNewline: false };
    const endsWithNewline = content.endsWith('\n');
    const body = endsWithNewline ? content.slice(0, -1) : content;
    return { lines: body.split('\n'), endsWithNewline };
}

function emitNewFile(path: string, content: string): string {
    const { lines, endsWithNewline } = splitLines(content);
    const out: string[] = [];
    out.push(`diff --git a/${path} b/${path}`);
    out.push('new file mode 100644');
    out.push('--- /dev/null');
    out.push(`+++ b/${path}`);
    out.push(`@@ -0,0 +1,${lines.length} @@`);
    for (const l of lines) out.push(`+${l}`);
    if (!endsWithNewline && lines.length > 0) out.push('\\ No newline at end of file');
    return out.join('\n');
}

function emitDeletedFile(path: string): string {
    // A content-overlay deletion carries no pre-image bytes; we emit a
    // delete-file marker with an empty body. The settle path applies the
    // tombstone by removing the file directly (it does not `git apply` this),
    // so an empty deletion hunk is sufficient and round-trips losslessly.
    const out: string[] = [];
    out.push(`diff --git a/${path} b/${path}`);
    out.push('deleted file mode 100644');
    out.push(`--- a/${path}`);
    out.push('+++ /dev/null');
    return out.join('\n');
}

/**
 * Project a content-overlay into a git-style unified diff. Paths are emitted in
 * sorted order for determinism. Returns `''` for an empty patch.
 */
export function overlayToDiff(baseSha: string, patch: WorkspacePatch): string {
    void baseSha; // recorded by the caller alongside the wire patch; not in the body
    const paths = Object.keys(patch.files).sort();
    const blocks: string[] = [];
    for (const p of paths) {
        const entry = patch.files[p];
        blocks.push(isDeleted(entry) ? emitDeletedFile(p) : emitNewFile(p, entry.content));
    }
    if (blocks.length === 0) return '';
    return blocks.join('\n') + '\n';
}

/**
 * Inverse of {@link overlayToDiff}: parse the new-file/deleted-file form back
 * into a content-overlay. `baseSha` is supplied by the caller (it is not in the
 * diff body). Throws on a malformed block.
 */
export function diffToOverlay(baseSha: string, diff: string): WorkspacePatch {
    const files: Record<string, PatchEntry> = {};
    if (diff.trim() === '') return { baseSha, files };

    const lines = diff.split('\n');
    let i = 0;
    while (i < lines.length) {
        const header = lines[i];
        if (header === '') { i++; continue; }
        const m = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
        if (!m) throw new Error(`diffToOverlay: expected 'diff --git' header, got: ${header}`);
        const path = m[1];
        i++;
        const mode = lines[i];
        if (mode === 'deleted file mode 100644') {
            files[path] = { deleted: true };
            // skip the ---/+++ lines of the delete block
            i++;
            while (i < lines.length && !lines[i].startsWith('diff --git ')) i++;
            continue;
        }
        if (mode !== 'new file mode 100644') {
            throw new Error(`diffToOverlay: expected new/deleted file mode, got: ${mode}`);
        }
        i++; // mode
        // --- /dev/null
        if (lines[i] !== '--- /dev/null') throw new Error('diffToOverlay: expected --- /dev/null');
        i++;
        // +++ b/<path>
        if (lines[i] !== `+++ b/${path}`) throw new Error('diffToOverlay: +++ path mismatch');
        i++;
        // @@ hunk header
        if (!/^@@ /.test(lines[i] ?? '')) throw new Error('diffToOverlay: expected @@ hunk header');
        i++;
        const body: string[] = [];
        let noNewline = false;
        while (i < lines.length && !lines[i].startsWith('diff --git ')) {
            const l = lines[i];
            if (l === '\\ No newline at end of file') { noNewline = true; i++; continue; }
            if (l.startsWith('+')) body.push(l.slice(1));
            i++;
        }
        const content = body.length === 0
            ? ''
            : body.join('\n') + (noNewline ? '' : '\n');
        files[path] = { content };
    }
    return { baseSha, files };
}
