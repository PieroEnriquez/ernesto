/**
 * Workflow reader port + a minimal multi-source aggregator.
 *
 * Concrete adapters (the backend's `makeWorkspacesWorkflowReader`)
 * scan a filesystem tree and feed declarations through this port.
 * The lib also exposes `createMultiSourceWorkflowReader` so callers
 * with multiple source roots (e.g. system-level workflows + tenant
 * workspaces) can wire them up without writing per-call merges.
 */

import type { WorkflowDeclaration } from '../workflows/types';

export interface WorkflowSummary {
    /** Workflow slug. Matches `declaration.name`. */
    name: string;
    /** Source path / URI for debugging. */
    path: string;
    /** Stable content hash for dedupe + cache invalidation. */
    sha: string;
    cwd?: string;
}

export interface WorkflowDetail extends WorkflowSummary {
    source: string;
    declaration: WorkflowDeclaration;
}

export interface WorkflowReader {
    list(): Promise<WorkflowSummary[]>;
    read(name: string): Promise<WorkflowDetail | undefined>;
}

/**
 * Aggregate several readers into one. The earlier reader in the list
 * wins on slug collision — which lets callers layer source-of-truth
 * orderings (e.g. tenant overrides > shared library).
 */
export function createMultiSourceWorkflowReader(
    readers: ReadonlyArray<WorkflowReader>,
): WorkflowReader {
    return {
        async list(): Promise<WorkflowSummary[]> {
            const seen = new Set<string>();
            const out: WorkflowSummary[] = [];
            for (const r of readers) {
                const items = await r.list();
                for (const item of items) {
                    if (seen.has(item.name)) continue;
                    seen.add(item.name);
                    out.push(item);
                }
            }
            return out;
        },
        async read(name: string): Promise<WorkflowDetail | undefined> {
            for (const r of readers) {
                const found = await r.read(name);
                if (found) return found;
            }
            return undefined;
        },
    };
}
