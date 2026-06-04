/**
 * `timeoutMiddleware` — chain `kind.policy.timeoutMs` into an
 * AbortSignal that fires after the declared timeout. Composes with
 * the caller's `opts.abortSignal` — whichever fires first wins.
 *
 * The runner's walker reads `ctx.signal` per step; firing aborts the
 * in-flight step's `await` and cascades through the dispatcher. The
 * subworkflow handler propagates the signal to children.
 *
 * Service-level route kinds with `timeoutMs: 60_000` get a hard 60s budget;
 * in-process sessions usually omit timeoutMs (unbounded — bounded
 * by the user's patience instead).
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';

export function timeoutMiddleware(): DispatchMiddleware {
    return {
        name: 'timeout',
        before(ctx: DispatchPreContext): DispatchPreContext {
            const timeoutMs = ctx.decl?.policy?.timeoutMs;
            if (!timeoutMs || timeoutMs <= 0) return ctx;

            // Compose signals: a fresh controller that aborts on
            // timer OR on the caller's signal (whichever first).
            const composed = new AbortController();
            const t = setTimeout(() => {
                composed.abort(new Error(`dispatch timeout after ${timeoutMs}ms`));
            }, timeoutMs);
            // Don't keep the event loop alive solely for the timer.
            if (typeof (t as { unref?: () => void }).unref === 'function') {
                (t as { unref?: () => void }).unref!();
            }

            const parentSignal = ctx.opts.abortSignal;
            if (parentSignal) {
                if (parentSignal.aborted) {
                    composed.abort(parentSignal.reason);
                    clearTimeout(t);
                } else {
                    parentSignal.addEventListener(
                        'abort',
                        () => {
                            composed.abort(parentSignal.reason);
                            clearTimeout(t);
                        },
                        { once: true },
                    );
                }
            }

            ctx.opts = { ...ctx.opts, abortSignal: composed.signal };
            // Stash the timer handle for the after-hook to clear in
            // case the run terminates before the timeout fires.
            ctx.annotations.__timeoutTimer = t;
            return ctx;
        },
        after(ctx) {
            const t = ctx.annotations.__timeoutTimer;
            if (t) clearTimeout(t as ReturnType<typeof setTimeout>);
        },
    };
}
