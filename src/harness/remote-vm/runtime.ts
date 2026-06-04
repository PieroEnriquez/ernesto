/**
 * `VmRuntime` — the agent-runtime axis of the VM layer.
 *
 * The microVM is a *placement* (where an agent process runs, with a FUSE
 * workdir + egress allowlist). WHICH agent runtime runs inside it — the
 * Claude Agent SDK CLI (`cas`), `cursor-agent`, … — is orthogonal. A
 * `VmRuntime` captures exactly that orthogonal piece: how to launch the
 * runtime as an NDJSON-streaming process, and how to map its lines to the
 * canonical `HarnessEvent`s. The VM harness composes any `VmRuntime`; it is
 * not hardcoded to claude.
 *
 * The event mapping reuses each runtime's existing translator (cas/events,
 * cursor/events) — there is one event table per runtime, shared across
 * placements (local subprocess vs in-VM). `fragua-pi` has no exec-able CLI
 * (it's an in-process API loop), so it has no `VmRuntime` until packaged as
 * a launchable entrypoint — the abstraction correctly admits only
 * process-based runtimes.
 */

import type { AgentDefinition, HarnessEvent } from '../types';

export interface VmRuntime {
    /** Runtime id, e.g. `claude` | `cursor`. */
    readonly name: string;
    /** argv to launch the runtime in the VM. MUST stream events as NDJSON on
     *  stdout (one JSON object per line). cwd is the FUSE mount. */
    buildArgv(def: AgentDefinition, prompt: string): string[];
    /** Fresh per-run translator state (threaded across lines). */
    createState(): unknown;
    /** Map one NDJSON stdout line → `HarnessEvent`s. Blank/non-JSON → []. */
    mapLine(line: string, runId: string, state: unknown): HarnessEvent[];
}
