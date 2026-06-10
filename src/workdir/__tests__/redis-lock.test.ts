import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeRedisWorkdirLock, WorkdirLockAcquireTimeout, type RedisLockClient } from '../lock';

/**
 * In-memory fake of `RedisLockClient`. Uses a Map keyed by lock key
 * holding `{ value, expiresAt }`. Lazy expiration on every read.
 */
function makeFakeRedis(): RedisLockClient & {
    _store: Map<string, { value: string; expiresAt: number }>;
    _hold: (key: string, value: string, ttlMs: number) => void;
} {
    const store = new Map<string, { value: string; expiresAt: number }>();
    const isAlive = (key: string): boolean => {
        const e = store.get(key);
        if (!e) return false;
        if (e.expiresAt <= Date.now()) {
            store.delete(key);
            return false;
        }
        return true;
    };
    return {
        _store: store,
        _hold(key, value, ttlMs) {
            store.set(key, { value, expiresAt: Date.now() + ttlMs });
        },
        async setNxPx(key, value, ttlMs) {
            if (isAlive(key)) return false;
            store.set(key, { value, expiresAt: Date.now() + ttlMs });
            return true;
        },
        async pexpire(key, ttlMs) {
            const e = store.get(key);
            if (!e) return false;
            e.expiresAt = Date.now() + ttlMs;
            return true;
        },
        async releaseIfOwned(key, value) {
            const e = store.get(key);
            if (!e) return false;
            if (e.value !== value) return false;
            store.delete(key);
            return true;
        },
    };
}

describe('makeRedisWorkdirLock', () => {
    let redis: ReturnType<typeof makeFakeRedis>;

    beforeEach(() => {
        redis = makeFakeRedis();
    });

    it('acquires, runs fn, releases (happy path)', async () => {
        const lock = makeRedisWorkdirLock(redis, 'wd1');
        const result = await lock(async () => 'hello');
        expect(result).toBe('hello');
        // Lock must be released after fn completes.
        expect(redis._store.has('ernesto:workdir-lock:wd1')).toBe(false);
    });

    it('serializes two concurrent calls on the same workdirId', async () => {
        const lock = makeRedisWorkdirLock(redis, 'wd-serial', { pollIntervalMs: 10 });
        const order: string[] = [];

        const a = lock(async () => {
            order.push('a-start');
            await new Promise((r) => setTimeout(r, 50));
            order.push('a-end');
            return 'a';
        });
        const b = lock(async () => {
            order.push('b-start');
            await new Promise((r) => setTimeout(r, 10));
            order.push('b-end');
            return 'b';
        });

        const [resA, resB] = await Promise.all([a, b]);
        expect(resA).toBe('a');
        expect(resB).toBe('b');
        // a must run fully before b even starts.
        expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
        expect(redis._store.has('ernesto:workdir-lock:wd-serial')).toBe(false);
    });

    it('throws WorkdirLockAcquireTimeout when held by someone else', async () => {
        // Pre-occupy the lock with a different "owner".
        redis._hold('ernesto:workdir-lock:wd-busy', 'other-token', 10_000);

        const lock = makeRedisWorkdirLock(redis, 'wd-busy', {
            acquireTimeoutMs: 100,
            pollIntervalMs: 20,
        });

        await expect(lock(async () => 'never')).rejects.toBeInstanceOf(WorkdirLockAcquireTimeout);
    });

    it('auto-renews the lock while fn() runs longer than ttlMs', async () => {
        const pexpireSpy = vi.spyOn(redis, 'pexpire');
        const lock = makeRedisWorkdirLock(redis, 'wd-renew', {
            ttlMs: 90,
            autoRenewIntervalMs: 30,
            pollIntervalMs: 10,
            acquireTimeoutMs: 1000,
        });

        const result = await lock(async () => {
            // Run ~3x ttlMs — without renew the entry would have expired.
            await new Promise((r) => setTimeout(r, 250));
            const entry = redis._store.get('ernesto:workdir-lock:wd-renew');
            // While fn is still running, the lock must still be alive.
            expect(entry).toBeDefined();
            expect(entry!.expiresAt).toBeGreaterThan(Date.now());
            return 'done';
        });

        expect(result).toBe('done');
        expect(pexpireSpy).toHaveBeenCalled();
        // Released afterwards.
        expect(redis._store.has('ernesto:workdir-lock:wd-renew')).toBe(false);
    });

    it('releases the lock even if fn() throws', async () => {
        const lock = makeRedisWorkdirLock(redis, 'wd-err');
        const boom = new Error('boom');

        await expect(
            lock(async () => {
                throw boom;
            }),
        ).rejects.toBe(boom);
        expect(redis._store.has('ernesto:workdir-lock:wd-err')).toBe(false);

        // Subsequent acquisition still works.
        const ok = await lock(async () => 'ok');
        expect(ok).toBe('ok');
    });
});
