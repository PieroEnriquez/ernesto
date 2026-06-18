import { describe, expect, it, vi } from 'vitest';
import { selectPhysicalProjector } from '../physical-projector';
import type { PhysicalProjector, WriteThroughEngine } from '../physical-projector';

const fallbackRoot = { workdirRoot: '/fallback/workdir' };
const engineRoot = { workdirRoot: '/engine/workdir' };

function makeFallback(): PhysicalProjector & { calls: number } {
    let calls = 0;
    const fn = (async () => {
        calls += 1;
        return fallbackRoot;
    }) as PhysicalProjector & { calls: number };
    Object.defineProperty(fn, 'calls', { get: () => calls });
    return fn;
}

describe('selectPhysicalProjector', () => {
    it('returns the fallback verbatim when no engine is wired (no-regression floor)', async () => {
        const fallback = makeFallback();
        const projector = selectPhysicalProjector({ fallback });
        // Identity: the exact same function reference is returned, not a wrapper.
        expect(projector).toBe(fallback);
        await expect(projector()).resolves.toEqual(fallbackRoot);
    });

    it('prefers the write-through engine when it reports available', async () => {
        const fallback = makeFallback();
        const project = vi.fn(async () => engineRoot);
        const engine: WriteThroughEngine = { available: async () => true, project };
        const onSelect = vi.fn();
        const projector = selectPhysicalProjector({ engine, fallback, onSelect });

        await expect(projector()).resolves.toEqual(engineRoot);
        expect(project).toHaveBeenCalledOnce();
        expect(fallback.calls).toBe(0);
        expect(onSelect).toHaveBeenCalledWith('write-through');
    });

    it('falls back cleanly when the engine reports unavailable (negative probe is not an error)', async () => {
        const fallback = makeFallback();
        const project = vi.fn(async () => engineRoot);
        const engine: WriteThroughEngine = { available: async () => false, project };
        const onSelect = vi.fn();
        const projector = selectPhysicalProjector({ engine, fallback, onSelect });

        await expect(projector()).resolves.toEqual(fallbackRoot);
        expect(project).not.toHaveBeenCalled();
        expect(fallback.calls).toBe(1);
        expect(onSelect).toHaveBeenCalledWith('engine-unavailable');
    });

    it('falls back when the capability probe throws (probe error ⇒ unavailable, never propagated)', async () => {
        const fallback = makeFallback();
        const engine: WriteThroughEngine = {
            available: async () => {
                throw new Error('no /dev/fuse');
            },
            project: vi.fn(async () => engineRoot),
        };
        const onSelect = vi.fn();
        const projector = selectPhysicalProjector({ engine, fallback, onSelect });

        await expect(projector()).resolves.toEqual(fallbackRoot);
        expect(fallback.calls).toBe(1);
        expect(onSelect).toHaveBeenCalledWith('engine-unavailable', { reason: 'no /dev/fuse' });
    });

    it('falls back when projection throws after a positive probe', async () => {
        const fallback = makeFallback();
        const engine: WriteThroughEngine = {
            available: async () => true,
            project: async () => {
                throw new Error('mount failed');
            },
        };
        const onSelect = vi.fn();
        const projector = selectPhysicalProjector({ engine, fallback, onSelect });

        await expect(projector()).resolves.toEqual(fallbackRoot);
        expect(fallback.calls).toBe(1);
        expect(onSelect).toHaveBeenCalledWith('fallback', { reason: 'mount failed' });
    });

    it('probes the engine once per projection call', async () => {
        const fallback = makeFallback();
        const available = vi.fn(async () => true);
        const project = vi.fn(async () => engineRoot);
        const engine: WriteThroughEngine = { available, project };
        const projector = selectPhysicalProjector({ engine, fallback });

        await projector();
        await projector();
        expect(available).toHaveBeenCalledTimes(2);
        expect(project).toHaveBeenCalledTimes(2);
    });
});
