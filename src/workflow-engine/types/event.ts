/**
 * Fact-event taxonomy emitted by the runner. The `fact.*` namespace
 * is the canonical event channel for run lifecycle + step deltas.
 *
 * The canonical `fact.*` types live in {@link FactEventType}; the
 * narrow {@link TypedFactEvent} union encodes payload shapes per
 * type for in-lib emitters that want compile-time guarantees. The
 * widened {@link FactEvent} stays string-typed for forward-compat
 * with subscriber adapters that may see types from older/newer
 * runners.
 */

/** Bus event delivered to subscribers. */
export interface FactEvent {
    runId: string;
    seq: number;
    /** Canonical `fact.*` event tag (`fact.run_started`,
     *  `fact.run_paused_human`, `fact.node_completed`, …). */
    type: string;
    payload: Record<string, unknown>;
    ts: number;
    /** Per-run untyped routing blob (transport, scopes, parentRunId, …). */
    routing?: Readonly<Record<string, unknown>>;
}

/** Canonical `fact.*` type tags emitted by the lib. Subscribers
 *  may receive additional types from forward-version runners and
 *  must ignore unknown variants (the `FactEvent.type` field stays
 *  `string`-typed for that reason). */
export type FactEventType =
    | 'fact.run_started'
    | 'fact.run_resumed'
    | 'fact.run_paused_human'
    | 'fact.run_paused_signal'
    | 'fact.node_completed'
    | 'fact.run_terminated'
    | 'fact.assistant_message'
    | 'fact.assistant_delta'
    | 'fact.tool_call'
    | 'fact.tool_result'
    | 'fact.thinking'
    | 'fact.usage'
    | 'fact.subagent_started'
    | 'fact.subagent_completed'
    | 'fact.component';

/** Re-export so the `fact.component` typed-event payload below can
 *  refer to the canonical {@link UiComponent} shape without setting up
 *  a cross-module import cycle. */
import type { UiComponent } from '../../components/types';

/**
 * Narrowly-typed event union. The agent step handler emits these
 * when forwarding `HarnessEvent`s from a `RunHandle.stream()`; the
 * walker emits the lifecycle variants (`run_started`, `node_completed`,
 * `run_paused_human`, `run_terminated`).
 *
 * Each variant carries the canonical `runId`, the originating
 * `stepId` (when applicable), and a timestamp; payload-specific
 * fields mirror `HarnessEvent` 1:1 minus the redundant routing
 * bits the surrounding `FactEvent` envelope already owns.
 */
export type TypedFactEvent =
    | {
          type: 'fact.assistant_delta';
          runId: string;
          stepId: string;
          text: string;
          ts: number;
      }
    | {
          type: 'fact.tool_call';
          runId: string;
          stepId: string;
          toolUseId: string;
          name: string;
          input: unknown;
          ts: number;
      }
    | {
          type: 'fact.tool_result';
          runId: string;
          stepId: string;
          toolUseId: string;
          output: unknown;
          isError: boolean;
          ts: number;
      }
    | {
          type: 'fact.thinking';
          runId: string;
          stepId: string;
          text: string;
          ts: number;
      }
    | {
          type: 'fact.usage';
          runId: string;
          stepId: string;
          inputTokens: number;
          outputTokens: number;
          cacheRead?: number;
          cacheWrite?: number;
          costUsd?: number;
          modelUsage?: Record<
              string,
              { inputTokens: number; outputTokens: number; costUsd?: number }
          >;
          ts: number;
      }
    | {
          type: 'fact.subagent_started';
          runId: string;
          stepId: string;
          slug: string;
          subRunId: string;
          ts: number;
      }
    | {
          type: 'fact.subagent_completed';
          runId: string;
          stepId: string;
          slug: string;
          subRunId: string;
          result: unknown;
          ts: number;
      }
    | {
          type: 'fact.component';
          runId: string;
          stepId: string;
          /** The structured UI intent — see `components/types.ts`.
           *  Top-level kinds: thinking / status / progress / attachment
           *  / hitl. Per-transport subscribers switch on `component.kind`. */
          component: UiComponent;
          ts: number;
      };

/** Persisted form of a fact-event — adds a monotonic store-side seq
 *  and writer attribution for audit. */
export interface StoredEvent {
    runId: string;
    seq: number;
    type: string;
    writer: 'engine' | 'handler' | 'subscriber';
    payload: unknown;
    ts: number;
    routing?: Readonly<Record<string, unknown>>;
}

