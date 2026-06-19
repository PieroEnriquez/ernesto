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
    /** Home workspace LEAF name (= the route scheme = the scope key), set by
     *  the filesystem reader from the owning boundary's basename. A workflow's
     *  dispatch identity is `<workspace>://<name>`, so it lands in the same
     *  uniqueness-enforced namespace as routes; absent only for in-memory
     *  fakes that never register as a kind. */
    workspace?: string;
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
