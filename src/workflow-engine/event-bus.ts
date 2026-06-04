/**
 * In-process event bus. Wraps Node's EventEmitter so the rest of the
 * engine has a focused, typed surface.
 *
 * The bus carries every `FactEvent` the runner emits; subscribers
 * (per-transport translators, audit pipelines, HTTP SSE bridges) attach
 * here.
 */

import { EventEmitter } from 'node:events';
import type { FactEvent } from './types/event';
import type {
    SubscribeEventsOpts,
    EventSubscription,
} from './types/runner';

export class EventBus {
    private readonly ee = new EventEmitter();

    constructor() {
        this.ee.setMaxListeners(0);
    }

    emit(event: FactEvent): void {
        this.ee.emit('event', event);
    }

    async subscribe(opts: SubscribeEventsOpts): Promise<EventSubscription> {
        const handler = (raw: FactEvent) => {
            try {
                opts.onEvent(raw);
            } catch (err) {
                opts.onError?.(err as Error);
            }
        };
        this.ee.on('event', handler);
        return {
            close: async (): Promise<void> => {
                this.ee.off('event', handler);
            },
        };
    }
}
