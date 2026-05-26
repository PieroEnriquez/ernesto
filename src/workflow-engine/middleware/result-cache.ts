/**
 * `resultCacheMiddleware` — short-circuits dispatch when the kind
 * declares `policy.cacheable.ttlMs` and a fresh cached output exists.
 *
 * Why a middleware: most route URIs called by agents are read-heavy
 * (warehouse queries, blockchain lookups). With the unified runtime
 * every `execute(uri, params)` goes through `runner.dispatch`, so
 * routes pay the middleware-chain overhead per call. Caching the
 * output for kinds that opt in turns the second-call cost from a
 * full dispatch into a Map lookup + synthetic Run handle.
 *
 * Lifecycle:
 *   - `before(ctx)` — if `policy.cacheable.ttlMs > 0` and the cache
 *     has a fresh entry, stash the cached output on
 *     `ctx.annotations.__cacheHit`. The runner checks this annotation
 *     post-middleware and synthesizes a completed Run from the
 *     cached output without walking. On miss, stash the cache key on
 *     `ctx.annotations.__cacheHit__key` so the after-hook can write.
 *   - `after(ctx, run)` — on cache miss + successful completion,
 *     write `run.output` to the cache keyed by what `before` stashed.
 *     Misses don't re-cache. Errored / canceled / paused runs are
 *     never cached (we'd risk poisoning the cache with transient
 *     failures).
 *
 * Default key derivation: `${kind}|${stableStringify(inputs)}|${principalId}`.
 * The principal component scopes the cache per user — a user-A read
 * never satisfies a user-B request, which preserves scope semantics
 * (a route's effective output may depend on the principal's scope).
 * Future enhancement: `policy.cacheable.keyExpr` to override the key
 * derivation per kind.
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';
import type { Run } from '../types/runner';

export interface ResultCacheMiddlewareOpts {
    /** Override the default cache store (in-memory by default). Tests
     *  pass an injectable store; production wiring can swap in a
     *  shared store (Redis-backed, cross-process) when M3 lands. */
    store?: ResultCacheStore;
    /** Override the default cache-key derivation. */
    keyFor?: (ctx: DispatchPreContext) => string;
    /** Annotation key the middleware uses to mark a cache hit. The
     *  runner reads this to decide whether to skip the walk. */
    annotationKey?: string;
    /** Clock injection for deterministic tests. */
    now?: () => number;
}

export interface ResultCacheStore {
    /** Read a cached entry. `ctx` is forwarded so backends can scope
     *  themselves by request properties (workdirRoot, principal, kind).
     *  Memory backends ignore it; the workspace-backed store reads
     *  `ctx.workdirRoot`. Returns `undefined` on miss or expired. */
    get(key: string, ctx: DispatchPreContext): Promise<CachedEntry | undefined>;
    /** Persist a cached entry. Same ctx convention as `get`. */
    set(key: string, value: CachedEntry, ctx: DispatchPreContext): Promise<void>;
    /** Optional — used by tests to inspect store contents. */
    has?(key: string, ctx: DispatchPreContext): Promise<boolean>;
}

export interface CachedEntry {
    output: unknown;
    expiresAt: number;
}

/** In-memory cache store with lazy eviction (expired entries are
 *  cleaned on read, not on a sweep). Single-process. The async surface
 *  matches the `ResultCacheStore` contract — the operations themselves
 *  are synchronous against the in-memory Map; promises resolve
 *  immediately. */
export class InMemoryResultCache implements ResultCacheStore {
    private readonly map = new Map<string, CachedEntry>();
    constructor(private readonly nowFn: () => number = Date.now) {}
    async get(key: string): Promise<CachedEntry | undefined> {
        const entry = this.map.get(key);
        if (!entry) return undefined;
        if (entry.expiresAt < this.nowFn()) {
            this.map.delete(key);
            return undefined;
        }
        return entry;
    }
    async set(key: string, value: CachedEntry): Promise<void> {
        this.map.set(key, value);
    }
    async has(key: string): Promise<boolean> {
        return (await this.get(key)) !== undefined;
    }
}

export function resultCacheMiddleware(
    opts: ResultCacheMiddlewareOpts = {},
): DispatchMiddleware {
    const now = opts.now ?? Date.now;
    const store = opts.store ?? new InMemoryResultCache(now);
    const annotationKey = opts.annotationKey ?? '__cacheHit';
    const annotationCacheKey = `${annotationKey}__key`;
    const keyFor = opts.keyFor ?? defaultKeyFor;

    return {
        name: 'result-cache',
        async before(ctx: DispatchPreContext): Promise<DispatchPreContext> {
            const ttlMs = ctx.decl?.policy?.cacheable?.ttlMs;
            if (!ttlMs || ttlMs <= 0) return ctx;
            const key = keyFor(ctx);
            const cached = await store.get(key, ctx);
            if (cached) {
                ctx.annotations[annotationKey] = cached.output;
                return ctx;
            }
            ctx.annotations[annotationCacheKey] = key;
            return ctx;
        },
        async after(ctx: DispatchPreContext, run: Run): Promise<void> {
            const ttlMs = ctx.decl?.policy?.cacheable?.ttlMs;
            if (!ttlMs || ttlMs <= 0) return;
            // Hit — don't re-cache (already had it, used it).
            if (ctx.annotations[annotationKey] !== undefined) return;
            // Only cache successful completions. Caching errored
            // outputs would let transient failures poison the cache
            // for the TTL window.
            if (run.status !== 'completed') return;
            const key = ctx.annotations[annotationCacheKey] as string | undefined;
            if (!key) return;
            await store.set(
                key,
                {
                    output: run.output,
                    expiresAt: now() + ttlMs,
                },
                ctx,
            );
        },
    };
}

function defaultKeyFor(ctx: DispatchPreContext): string {
    const principalId =
        ctx.principal.kind === 'user'
            ? ctx.principal.userId
            : `service:${ctx.principal.workerId}`;
    return `${ctx.kind}|${stableStringify(ctx.inputs)}|${principalId}`;
}

/** Stable JSON stringify with sorted keys at every object level. Lets
 *  `{a:1, b:2}` and `{b:2, a:1}` produce the same cache key — important
 *  because JS object-literal key order isn't guaranteed across LLM
 *  serializations. */
function stableStringify(value: unknown): string {
    return JSON.stringify(value, sortedReplacer);
}

function sortedReplacer(_key: string, value: unknown): unknown {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const obj = value as Record<string, unknown>;
        const sorted: Record<string, unknown> = {};
        for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
        return sorted;
    }
    return value;
}
