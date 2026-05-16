import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import type { AgentDeclaration } from './types';
import { parseManagedAgentMd, toAgentDeclaration } from './from-md';

export interface DiscoveredAgent {
    declaration: AgentDeclaration;
    /** Workspace the declaration was sourced from. */
    workspace: string;
    /** Absolute path to the source markdown file. */
    sourcePath: string;
}

export interface DiscoverManagedAgentsError {
    /** Path that failed to parse. */
    sourcePath: string;
    workspace: string;
    slug: string;
    error: Error;
}

export interface DiscoverManagedAgentsResult {
    agents: DiscoveredAgent[];
    errors: DiscoverManagedAgentsError[];
}

/**
 * Walk `<workspacesRoot>/*\/managed-agents/*.md` and parse each file
 * into an `AgentDeclaration`. Files that fail to parse are returned in
 * `errors` instead of throwing — boot-time discovery should land every
 * valid agent and surface the broken ones for the operator, not refuse
 * to start.
 *
 * Slug rules:
 * - Filename stem must match `/^[a-z][a-z0-9-]{0,39}$/` (also enforced
 *   inside `toAgentDeclaration` against the frontmatter `slug`).
 * - Frontmatter `slug` must agree with the filename stem.
 *
 * The walk is synchronous on purpose — one filesystem scan per boot,
 * sub-ms even for hundreds of workspaces. Making it async would ripple
 * through boot sequencing for no measurable win.
 */
export function discoverManagedAgents(workspacesRoot: string): DiscoverManagedAgentsResult {
    const result: DiscoverManagedAgentsResult = { agents: [], errors: [] };
    let workspaces: string[];
    try {
        workspaces = readdirSync(workspacesRoot);
    } catch {
        return result;
    }

    for (const workspace of workspaces) {
        if (workspace.startsWith('.')) continue;
        const managedAgentsDir = join(workspacesRoot, workspace, 'managed-agents');
        let isDir = false;
        try {
            isDir = statSync(managedAgentsDir).isDirectory();
        } catch {
            continue;
        }
        if (!isDir) continue;

        for (const entry of readdirSync(managedAgentsDir)) {
            if (!entry.endsWith('.md')) continue;
            const slug = entry.slice(0, -3);
            const sourcePath = join(managedAgentsDir, entry);
            try {
                const raw = readFileSync(sourcePath, 'utf8');
                const md = parseManagedAgentMd(raw, { slug, workspace });
                const declaration = toAgentDeclaration(md);
                result.agents.push({ declaration, workspace, sourcePath });
            } catch (error) {
                result.errors.push({
                    sourcePath,
                    workspace,
                    slug,
                    error: error instanceof Error ? error : new Error(String(error)),
                });
            }
        }
    }

    return result;
}
