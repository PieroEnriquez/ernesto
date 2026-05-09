import { randomUUID } from 'crypto';
import { WorkdirLock } from './types';

const chains = new Map<string, Promise<unknown>>();

/**
 * In-process per-workdirId mutex. Used for tests, single-pod deployments,
 * and the laptop CLI (single process). Cross-pod safety needs the Redis
 * variant (`makeRedisWorkdirLock`) — same `(fn) => Promise<T>` shape.
 *
 * Errors in one call do not block subsequent calls; the chain continues.
 */
export function makeInMemoryWorkdirLock(workdirId: string): WorkdirLock {
    return <T,>(fn: () => Promise<T>): Promise<T> => {
        const prev = chains.get(workdirId) ?? Promise.resolve();
        const next = prev.then(fn, fn);
        chains.set(workdirId, next.catch(() => undefined));
        return next as Promise<T>;
    };
}

/**
 * Minimal Redis surface needed by `makeRedisWorkdirLock`. The deployer
 * adapts a real client (e.g. `ioredis`) to this shape so the kernel
 * stays free of any client dependency.
 */
export interface RedisLockClient {
    /** SET key value NX PX ttlMs — returns true if acquired, false if held by someone else. */
    setNxPx(key: string, value: string, ttlMs: number): Promise<boolean>;
    /** PEXPIRE key ttlMs — returns true if renewed. */
    pexpire(key: string, ttlMs: number): Promise<boolean>;
    /** Atomic compare-and-delete via Lua: deletes key only if value matches. */
    releaseIfOwned(key: string, value: string): Promise<boolean>;
}

/**
 * Thrown when `makeRedisWorkdirLock` cannot acquire the lock within
 * `acquireTimeoutMs`. Surfaces the workdirId for ergonomic logging.
 */
export class WorkdirLockAcquireTimeout extends Error {
    public readonly workdirId: string;
    public readonly key: string;
    public readonly waitedMs: number;

    constructor(workdirId: string, key: string, waitedMs: number) {
        super(`Timed out acquiring workdir lock for ${workdirId} after ${waitedMs}ms`);
        this.name = 'WorkdirLockAcquireTimeout';
        this.workdirId = workdirId;
        this.key = key;
        this.waitedMs = waitedMs;
    }
}

const DEFAULTS = {
    keyPrefix: 'ernesto:workdir-lock:',
    ttlMs: 30_000,
    acquireTimeoutMs: 30_000,
    pollIntervalMs: 250,
};

/**
 * Cross-pod per-workdirId mutex backed by a Redis SET NX PX advisory
 * lock with auto-renewal while `fn()` runs. Same `(fn) => Promise<T>`
 * shape as `makeInMemoryWorkdirLock`. The deployer wires the client.
 */
export function makeRedisWorkdirLock(
    redis: RedisLockClient,
    workdirId: string,
    opts?: {
        keyPrefix?: string;
        ttlMs?: number;
        acquireTimeoutMs?: number;
        pollIntervalMs?: number;
        autoRenewIntervalMs?: number;
    },
): WorkdirLock {
    const keyPrefix = opts?.keyPrefix ?? DEFAULTS.keyPrefix;
    const ttlMs = opts?.ttlMs ?? DEFAULTS.ttlMs;
    const acquireTimeoutMs = opts?.acquireTimeoutMs ?? DEFAULTS.acquireTimeoutMs;
    const pollIntervalMs = opts?.pollIntervalMs ?? DEFAULTS.pollIntervalMs;
    const autoRenewIntervalMs = opts?.autoRenewIntervalMs ?? Math.max(1, Math.floor(ttlMs / 3));
    const key = `${keyPrefix}${workdirId}`;

    return async <T,>(fn: () => Promise<T>): Promise<T> => {
        const token = randomUUID();
        const deadline = Date.now() + acquireTimeoutMs;

        // 1. Acquire (with bounded wait).
        let acquired = false;
        while (true) {
            // eslint-disable-next-line no-await-in-loop
            acquired = await redis.setNxPx(key, token, ttlMs);
            if (acquired) break;
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new WorkdirLockAcquireTimeout(workdirId, key, acquireTimeoutMs);
            }
            const wait = Math.min(pollIntervalMs, remaining);
            // eslint-disable-next-line no-await-in-loop
            await new Promise<void>(resolve => setTimeout(resolve, wait));
        }

        // 2. Auto-renew while fn() runs.
        const renewer = setInterval(() => {
            redis.pexpire(key, ttlMs).catch(err => {
                // Don't blow up the host process; the lock will simply lapse
                // and the next caller will pick it up.
                // eslint-disable-next-line no-console
                console.warn(
                    '[ernesto] workdir lock pexpire failed',
                    { workdirId, key, err: err instanceof Error ? err.message : String(err) },
                );
            });
        }, autoRenewIntervalMs);
        // Don't keep the event loop alive just because of the renewer.
        if (typeof renewer.unref === 'function') renewer.unref();

        try {
            return await fn();
        } finally {
            clearInterval(renewer);
            try {
                await redis.releaseIfOwned(key, token);
            } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(
                    '[ernesto] workdir lock release failed',
                    { workdirId, key, err: err instanceof Error ? err.message : String(err) },
                );
            }
        }
    };
}
