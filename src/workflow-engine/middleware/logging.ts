/**
 * `loggingMiddleware` — observability hook around every dispatch.
 *
 * Emits a "dispatch start" log line on `before` and a "dispatch end"
 * line with status + durationMs + costUsd on `after`. Per-transport
 * adapters can subscribe to the structured log output to populate
 * dashboards (Scalyr/Datadog/etc.) without touching the dispatch
 * code.
 *
 * The middleware reads `principal.kind`, `kind` URI, and (post-hoc)
 * `run.status`, `run.durationMs`, `run.usage.costUsd`. No sensitive
 * data — see CLAUDE.md "NEVER log sensitive data": inputs/outputs
 * are NOT logged here (they can contain PII or secrets); structured
 * fields only.
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';
import { principalIdentity } from '../principal';
import type { Run } from '../types/runner';

/** Re-import the logger type via the public surface. */
type Log = {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
};

export interface LoggingMiddlewareOpts {
    /** Logger sink. Defaults to a no-op — callers wire in their
     *  per-file logger. */
    log?: Log;
    /** Field-mask hook — callers can redact transport-specific fields
     *  from the structured metadata before it ships. Default: pass
     *  through. */
    redact?: (meta: Record<string, unknown>) => Record<string, unknown>;
}

export function loggingMiddleware(opts: LoggingMiddlewareOpts = {}): DispatchMiddleware {
    const log: Log = opts.log ?? { info: () => undefined, warn: () => undefined };
    const redact = opts.redact ?? ((m) => m);

    return {
        name: 'logging',
        before(ctx: DispatchPreContext): DispatchPreContext {
            ctx.annotations.__loggingStartedAt = Date.now();
            log.info(
                'dispatch start',
                redact({
                    kind: ctx.kind,
                    principal: principalIdentity(ctx.principal),
                    transport: ctx.opts.transport,
                    surfaceRunId: ctx.opts.surfaceRunId,
                    parentRunId: ctx.opts.parentRunId,
                }),
            );
            return ctx;
        },
        after(ctx: DispatchPreContext, run: Run): void {
            const startedAt = ctx.annotations.__loggingStartedAt as number | undefined;
            const wallMs = startedAt ? Date.now() - startedAt : undefined;
            const meta: Record<string, unknown> = {
                kind: ctx.kind,
                runId: run.runId,
                status: run.status,
                durationMs: run.durationMs,
                wallMs,
                costUsd: run.usage.costUsd,
                inputTokens: run.usage.inputTokens,
                outputTokens: run.usage.outputTokens,
            };
            if (run.status === 'errored' && run.error) {
                meta.errorCode = run.error.code;
                meta.errorMessage = run.error.message;
                log.warn('dispatch errored', redact(meta));
                return;
            }
            log.info('dispatch end', redact(meta));
        },
    };
}
