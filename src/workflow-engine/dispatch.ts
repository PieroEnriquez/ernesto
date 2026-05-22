/**
 * Kind-keyed handler registry. The runner holds one of these per
 * instance; `registerStepKind` and lookup go through here.
 *
 * The registry exists as a tiny separate module (rather than inline
 * in `runner.ts`) so tests can construct one in isolation and so
 * future additions like introspection (`listKinds()`) have a home.
 */

import type { StepKind } from '../workflows/types';
import type { StepKindHandler } from './types/handler';

export class HandlerDispatcher {
    private readonly handlers = new Map<StepKind, StepKindHandler>();

    register(kind: StepKind, handler: StepKindHandler<any>): void {
        if (this.handlers.has(kind)) {
            throw new Error(`step kind already registered: ${kind}`);
        }
        this.handlers.set(kind, handler as StepKindHandler);
    }

    has(kind: StepKind): boolean {
        return this.handlers.has(kind);
    }

    /** Look up the handler for `kind`, or throw if missing. */
    require(kind: StepKind): StepKindHandler {
        const h = this.handlers.get(kind);
        if (!h) throw new Error(`no handler registered for kind ${kind}`);
        return h;
    }

    listKinds(): StepKind[] {
        return [...this.handlers.keys()];
    }
}
