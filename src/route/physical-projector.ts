/**
 * Physical-projector selection — the `projectPhysical()` capability seam.
 *
 * `WorkspaceView.projectPhysical()` returns a real on-disk `{ workdirRoot }`
 * that eager consumers (git clone for settle staging, `git read-tree -m -u`,
 * native sandboxed SDK tools, `code://materialize` hard-links) stat and read
 * directly. There are two ways to back it:
 *
 *   1. A WRITE-THROUGH / LAZY-HYDRATE engine (eden-lite / FUSE): the on-disk
 *      tree is a live projection of the bound `master-FS ⊕ draft` overlay —
 *      paths hydrate on touch, writes copy-up into the same draft the view
 *      reads. This is the convergence target. It requires a real mount
 *      (Linux + /dev/fuse + the native binding) and is therefore only
 *      available inside a guest VM, never the backend Node process.
 *
 *   2. The MATERIALIZE-THEN-READ fallback (`openWorkdir`): the overlay is
 *      walked once into a git-less physical tree, stamp-cached. This is the
 *      current behavior on every backend transport and on the dev host.
 *
 * `selectPhysicalProjector` makes the preference explicit and capability-gated:
 * it PREFERS the write-through engine when a probe reports it is available,
 * and otherwise falls back to the supplied projector — which is exactly
 * today's behavior, so a host without the engine sees no regression. The probe
 * runs at most once per projection and never throws into the caller: a probe
 * failure (or an unavailable engine) is a clean fall-through to the fallback.
 *
 * This is pure (no FS, no native deps) so it is unit-testable without a mount;
 * the concrete engine + probe are injected by the backend transport layer.
 */

/** A function that materializes a real on-disk workdir and returns its root. */
export type PhysicalProjector = () => Promise<{ workdirRoot: string }>;

/**
 * The write-through / lazy-hydrate engine slot. `available()` is a cheap
 * capability probe (e.g. "is a FUSE mount possible on this host?"); `project()`
 * mounts/binds the overlay-backed tree and returns its root. Both are async so
 * a real engine can do I/O.
 */
export interface WriteThroughEngine {
    /** Cheap capability probe. `true` ⇒ `project()` may be used. Must not throw;
     *  a thrown probe is treated as "unavailable" by `selectPhysicalProjector`. */
    available(): Promise<boolean>;
    /** Mount/bind the overlay-backed tree and return its on-disk root. */
    project(): Promise<{ workdirRoot: string }>;
}

export interface SelectPhysicalProjectorOpts {
    /** The preferred write-through engine. When absent, selection is the
     *  `fallback` verbatim — the seam is inert until an engine is wired. */
    engine?: WriteThroughEngine;
    /** The materialize-then-read projector. This IS the current behavior and
     *  the no-regression floor: used whenever the engine is absent, reports
     *  unavailable, or its probe/projection fails. */
    fallback: PhysicalProjector;
    /** Optional structured log sink. Called with a stable event key + meta so
     *  the caller's per-file logger can record which path was taken. Never
     *  passed secrets/PII — only the chosen path and an error message. */
    onSelect?: (event: 'write-through' | 'fallback' | 'engine-unavailable', meta?: { reason?: string }) => void;
}

/**
 * Build a `PhysicalProjector` that prefers the write-through engine when
 * available and falls back to the supplied projector otherwise.
 *
 * The returned projector probes the engine once per call; on a positive probe
 * it projects through the engine, and ONLY a thrown probe/projection drops to
 * the fallback (a negative probe is a clean, non-error fall-through). The
 * fallback is invoked verbatim, so callers that wire no engine — every backend
 * transport and the dev host today — get exactly the existing behavior.
 */
export function selectPhysicalProjector(opts: SelectPhysicalProjectorOpts): PhysicalProjector {
    const { engine, fallback, onSelect } = opts;
    if (!engine) {
        return fallback;
    }
    return async () => {
        let usable = false;
        try {
            usable = await engine.available();
        } catch (err) {
            onSelect?.('engine-unavailable', { reason: (err as Error).message });
            return fallback();
        }
        if (!usable) {
            onSelect?.('engine-unavailable');
            return fallback();
        }
        try {
            const projected = await engine.project();
            onSelect?.('write-through');
            return projected;
        } catch (err) {
            onSelect?.('fallback', { reason: (err as Error).message });
            return fallback();
        }
    };
}
