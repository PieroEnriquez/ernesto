/**
 * Content-overlay → unified-diff projection.
 *
 * The durable per-user state is a CONTENT-OVERLAY (full content per touched
 * path); the unified diff is the wire/settle representation (PROJECT.md §3.1).
 * `overlayToDiff` projects a {@link WorkspacePatch} into a `git apply`-able
 * unified diff: each present file is emitted as a full-content add (a
 * `/dev/null → b/<path>` new-file hunk), each tombstone as a full-content
 * delete (`a/<path> → /dev/null`). This form is self-contained — it does not
 * depend on the base bytes — so the projection is a pure function of the patch.
 *
 * (settle itself applies the overlay content directly and lets git 3-way
 * against current main — see `settle-from-overlay.ts`; the diff projection is
 * for the wire.)
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
 * sorted order for determinism. Returns `''` for an empty patch. The base sha
 * is not part of the diff body — it is recorded by the caller alongside the
 * wire patch.
 */
export function overlayToDiff(patch: WorkspacePatch): string {
    const paths = Object.keys(patch.files).sort();
    const blocks: string[] = [];
    for (const p of paths) {
        const entry = patch.files[p];
        blocks.push(isDeleted(entry) ? emitDeletedFile(p) : emitNewFile(p, entry.content));
    }
    if (blocks.length === 0) return '';
    return blocks.join('\n') + '\n';
}
