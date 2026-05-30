/**
 * Workflow reader port.
 *
 * Concrete adapters (the backend's `makeWorkspacesWorkflowReader`)
 * scan a filesystem tree and feed declarations through this port.
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
