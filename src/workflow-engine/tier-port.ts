/**
 * TierPort — the unified contract every tier subscriber implements.
 *
 * Slack (Tier A), claude.ai MCP (Tier B), Tier-C CLI, and the
 * agent-facing Ernesto MCP all become instances of one shape:
 *
 *   1. **Tail events** filtered by `surfaceRunId` (so a tier subscriber
 *      sees every event in a dispatch tree as one stream).
 *   2. **Render** each event into the tier's native UX (Slack Block
 *      Kit, MCP elicit/embed, chalk/cli-table3, MCP tool result).
 *   3. **Resolve HITL** when a `fact.run_paused_human` arrives — pop
 *      the tier-native UI (modal, elicit response, readline prompt),
 *      collect the answer, write an `intent.human_input` back via
 *      `runner.resumeRun()`.
 *   4. **Submit intents** when the user originates a new turn (Slack
 *      message, claude.ai conversation turn, CLI command). The
 *      subscriber calls `runner.dispatch(...)` with the user's
 *      principal and the conversation continuity key.
 *
 * The lib's job here is the contract + base lifecycle. Concrete
 * implementations live in backend modules (`subscribers/slack-*`,
 * `subscribers/claude-mcp-*`, etc.) or in `ernesto-cli`'s Tier-C
 * subscriber. Each implementation provides `render()` + tier-
 * specific HITL resolution.
 *
 * See workspaces/agent-ops/unified-runtime/architecture.md §"Tier ports".
 */

import type {
    WorkflowRunner,
    Run,
    DispatchOpts,
} from './types/runner';
import type { FactEvent } from './types/event';
import type { Principal } from './principal';

/** A HITL pause surfaced to a tier port. Carries everything a
 *  native renderer needs to ask the user. */
export interface HitlPauseRequest {
    runId: string;
    surfaceRunId: string;
    stepId: string;
    promptId: string;
    prompt: string;
    /** Discrete choices the user can pick. Tier renderers translate
     *  these into native UI (Slack action buttons, MCP enum elicit,
     *  CLI readline numbered list). */
    routes: string[];
    /** Optional JSON Schema — the original schema the input step
     *  declared. Tier renderers that support richer UI (modals,
     *  elicit forms) project this into native form fields. */
    schema?: unknown;
}

/** Filter applied to event tail — limits the stream to events
 *  relevant to this tier port. Subscribers usually filter by
 *  `surfaceRunId` (one Slack thread = one surface = one filter) or
 *  by tier metadata when scanning broadly. */
export interface TierEventFilter {
    surfaceRunId?: string;
    tier?: 'A' | 'B' | 'C';
    /** Predicate for fine-grained filtering. Applied after the
     *  declarative filters above. */
    predicate?: (ev: FactEvent) => boolean;
}

/** The TierPort lifecycle. Implementations extend this base and
 *  fill in tier-native renderers + resolvers. */
export abstract class TierPort {
    protected closed = false;

    constructor(
        protected readonly runner: WorkflowRunner,
        protected readonly filter: TierEventFilter = {},
    ) {}

    /**
     * Render one fact event into the tier's native UX. Called once
     * per matching event from the tail loop. Implementations
     * dispatch on `event.type` and project to native primitives.
     */
    abstract render(event: FactEvent): void | Promise<void>;

    /**
     * Resolve a HITL pause. Pop the tier-native input UI (Slack
     * modal, MCP elicit, CLI readline), collect the answer.
     * Returns the user's resolution value. Tier ports that don't
     * support HITL (the agent-facing MCP) throw to fail-fast.
     */
    abstract resolveHitl(pause: HitlPauseRequest): Promise<unknown>;

    /**
     * Submit an intent — start a new dispatch as this user. Returns
     * the `Run<TOut>` handle the caller can `waitForTerminal()` or
     * `events()` from. Implementations typically wrap with tier-
     * specific metadata (slackThreadId, claudeAiConvId, cliPid)
     * placed in `opts.context`.
     */
    async submit<TOut = Record<string, unknown>>(
        kind: string,
        inputs: Record<string, unknown>,
        principal: Principal,
        opts: DispatchOpts = {},
    ): Promise<Run<TOut>> {
        return this.runner.dispatch<TOut>(kind, inputs, principal, opts);
    }

    /**
     * Start the tail loop. Subscribes to the runner's event bus and
     * forwards matching events to `render()`. HITL pauses are
     * detected here and routed to `resolveHitl()` + `runner.resumeRun()`.
     *
     * Returns a teardown hook the caller closes when the tier port
     * shuts down.
     */
    async start(): Promise<() => Promise<void>> {
        const subscription = await this.runner.subscribeEvents({
            onEvent: (ev) => {
                if (this.closed) return;
                if (!this.matches(ev)) return;
                this.dispatchEvent(ev);
            },
            onError: () => {
                /* let derived class log if it cares */
            },
        });
        return async () => {
            this.closed = true;
            await subscription.close().catch(() => undefined);
        };
    }

    /** Default match: applies filter.surfaceRunId, filter.tier,
     *  filter.predicate. Override for more exotic filtering. */
    protected matches(ev: FactEvent): boolean {
        const routing = ev.routing as
            | { tier?: string; surfaceRunId?: string }
            | undefined;
        if (this.filter.surfaceRunId !== undefined) {
            const sr = routing?.surfaceRunId ?? ev.runId;
            if (sr !== this.filter.surfaceRunId) return false;
        }
        if (this.filter.tier !== undefined) {
            if (routing?.tier !== this.filter.tier) return false;
        }
        if (this.filter.predicate && !this.filter.predicate(ev)) {
            return false;
        }
        return true;
    }

    /** Internal: dispatch event to render() with HITL detection. */
    private async dispatchEvent(ev: FactEvent): Promise<void> {
        try {
            if (ev.type === 'fact.run_paused_human') {
                // HITL controller emits with payload keyed as `nodeId`,
                // `text`, `routes`, `promptId`; the JSON Schema rides
                // on the routing under `inputSchema`. See hitl.ts.
                const p = ev.payload as {
                    nodeId?: string;
                    promptId?: string;
                    text?: string;
                    routes?: string[];
                };
                const routing = ev.routing as
                    | { surfaceRunId?: string; inputSchema?: unknown }
                    | undefined;
                const request: HitlPauseRequest = {
                    runId: ev.runId,
                    surfaceRunId: routing?.surfaceRunId ?? ev.runId,
                    stepId: p.nodeId ?? '',
                    promptId: p.promptId ?? '',
                    prompt: p.text ?? '',
                    routes: p.routes ?? [],
                    ...(routing?.inputSchema !== undefined
                        ? { schema: routing.inputSchema }
                        : {}),
                };
                // First render the pause (so the user sees the
                // prompt), then await the user's resolution.
                await this.render(ev);
                const value = await this.resolveHitl(request);
                await this.runner.resumeRun({
                    runId: request.runId,
                    promptId: request.promptId,
                    value,
                });
                return;
            }
            await this.render(ev);
        } catch (err) {
            // Renderers shouldn't throw; if they do, log and drop the
            // event to keep the tail loop going.
            // eslint-disable-next-line no-console
            console.warn('TierPort render/resolve failed', {
                tier: this.filter.tier,
                error: (err as Error).message,
            });
        }
    }
}
