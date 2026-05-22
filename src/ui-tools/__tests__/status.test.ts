import { describe, it, expect, vi } from 'vitest';
import { handleStatus } from '../tool-handlers/status';
import type { UiToolContext } from '../types';
import type { UiHitlPauser } from '../types';

function makeCtx(): { ctx: UiToolContext; emitted: any[] } {
    const emitted: any[] = [];
    const ctx: UiToolContext = {
        runId: 'r-1',
        stepId: 's-1',
        emit: (ev) => emitted.push(ev),
        hitl: {} as UiHitlPauser,
    };
    return { ctx, emitted };
}

describe('ui.status handler', () => {
    it('emits a fact.component with kind=status + given props', async () => {
        const { ctx, emitted } = makeCtx();
        const result = await handleStatus(
            { text: 'fetching…', level: 'progress' },
            ctx,
        );
        expect(result).toEqual({ ok: true });
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
            type: 'fact.component',
            component: {
                kind: 'status',
                props: { text: 'fetching…', level: 'progress' },
            },
        });
        // No slotId when caller didn't pass one.
        expect(emitted[0].component.slotId).toBeUndefined();
    });

    it('propagates slotId for in-place updates', async () => {
        const { ctx, emitted } = makeCtx();
        await handleStatus(
            { text: 'summarizing…', slotId: 'main-status' } as any,
            ctx,
        );
        expect(emitted[0].component).toMatchObject({
            kind: 'status',
            slotId: 'main-status',
            props: { text: 'summarizing…' },
        });
        // slotId is not duplicated inside `props`.
        expect((emitted[0].component.props as any).slotId).toBeUndefined();
    });

    it('does NOT call hitl.pauseForHuman (non-input tool)', async () => {
        const pause = vi.fn();
        const ctx: UiToolContext = {
            runId: 'r',
            stepId: 's',
            emit: () => undefined,
            hitl: { pauseForHuman: pause } as unknown as UiHitlPauser,
        };
        await handleStatus({ text: 'x' }, ctx);
        expect(pause).not.toHaveBeenCalled();
    });
});
