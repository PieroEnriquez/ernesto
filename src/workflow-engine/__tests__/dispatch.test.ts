import { describe, it, expect } from 'vitest';
import { HandlerDispatcher } from '../dispatch';
import type { StepKindHandler } from '../types/handler';

const stub: StepKindHandler = async () => ({
    kind: 'completed',
    output: null,
});

describe('HandlerDispatcher', () => {
    it('registers and looks up handlers by kind', () => {
        const d = new HandlerDispatcher();
        d.register('route', stub);
        expect(d.has('route')).toBe(true);
        expect(d.require('route')).toBe(stub);
    });

    it('throws on duplicate registration', () => {
        const d = new HandlerDispatcher();
        d.register('route', stub);
        expect(() => d.register('route', stub)).toThrow(/already registered/);
    });

    it('require() throws for unknown kinds', () => {
        const d = new HandlerDispatcher();
        expect(() => d.require('route')).toThrow(/no handler/);
    });

    it('listKinds() returns the registered set', () => {
        const d = new HandlerDispatcher();
        d.register('route', stub);
        d.register('input', stub);
        expect(d.listKinds().sort()).toEqual(['input', 'route']);
    });
});
