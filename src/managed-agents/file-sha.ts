import { createHash } from 'crypto';

/**
 * Compute git's blob SHA-1 for the given UTF-8 content. Matches
 * exactly what `git hash-object <file>` prints — the algorithm is
 * `sha1("blob <byte_length>\0<content>")` where byte_length is the
 * UTF-8 byte count.
 *
 * Used by the §7 stop 6 approval flow: an `ernesto:agent-ops` admin
 * submits `{ rawMd, fileSha }` to the approve route; the backend
 * recomputes the hash here and rejects the call if they disagree.
 * No persistent backend clone of the workspaces repo is needed —
 * the cryptographic check is sufficient.
 */
export function gitBlobShaOf(content: string): string {
    const bytes = Buffer.from(content, 'utf8');
    const header = `blob ${bytes.length}\0`;
    return createHash('sha1').update(header).update(bytes).digest('hex');
}

/**
 * True iff `gitBlobShaOf(rawMd) === fileSha`. Convenience wrapper
 * the approve route uses to decide whether to accept a submission.
 */
export function verifyContentMatchesFileSha(rawMd: string, fileSha: string): boolean {
    return gitBlobShaOf(rawMd) === fileSha;
}
