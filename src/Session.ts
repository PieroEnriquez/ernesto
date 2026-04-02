/**
 * Session — Agent Interaction Surface
 *
 * Each session gives an agent access to workspaces and tools.
 * Four operations: open, run, write, settle.
 *
 * Tier 1 (MCP agents): Use this class via attachToMcpServer().
 * Tier 2 (bash agents): Use workspace tools/*.sh scripts directly.
 * Tier 3 (programmatic): Use SkillRegistry.resolveTool() directly.
 */

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { Ernesto } from './Ernesto';
import type { ToolContext, ToolResult } from './skill';

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface SessionUser {
    id: string;
    email?: string;
    scopes?: string[];
}

/**
 * Backend provides workspace git operations.
 * The lib defines the interface, the backend implements it.
 */
export interface WorkspaceProvider {
    setup(workspace: string, targetPath: string): Promise<void>;
    settle(workspacePath: string, message: string, meta: { sessionId: string; user?: string; workflow?: string }): Promise<SettleResult>;
}

export interface SettleResult {
    status: 'ok' | 'conflict' | 'settled' | 'clean' | 'error';
    commit?: string;
    summary?: string;
    conflicts?: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// Session
// ═══════════════════════════════════════════════════════════════════════════

export class Session {
    readonly id: string;
    readonly path: string;
    readonly user: SessionUser;
    private ernesto: Ernesto;
    private workspaceOps?: WorkspaceProvider;
    private setupWorkspaces = new Set<string>();

    constructor(
        ernesto: Ernesto,
        id: string,
        sessionPath: string,
        user: SessionUser,
        workspaceOps?: WorkspaceProvider,
    ) {
        this.ernesto = ernesto;
        this.id = id;
        this.path = sessionPath;
        this.user = user;
        this.workspaceOps = workspaceOps;
    }

    // ─── open ──────────────────────────────────────────────
    // Browse workspaces and read files.

    async open(filePath?: string): Promise<string> {
        if (!filePath) return this.overview();

        const resolved = this.resolve(filePath);
        const stat = await fs.stat(resolved).catch(() => null);
        if (!stat) return `Not found: ${filePath}`;

        if (stat.isDirectory()) {
            const entries = await fs.readdir(resolved, { withFileTypes: true });
            return entries.map(e =>
                `${e.isDirectory() ? 'd' : '-'} ${e.name}${e.isDirectory() ? '/' : ''}`
            ).join('\n');
        }

        // Workspace auto-setup: expanded workspace (has .git) → refresh on first access
        let setupPreamble = '';
        const wsName = this.extractWorkspaceName(filePath);
        if (wsName && !this.setupWorkspaces.has(wsName)) {
            const wsRootPath = this.resolveWorkspaceRoot(filePath);
            if (wsRootPath) {
                const hasGit = await fs.stat(path.join(wsRootPath, '.git')).catch(() => null);
                if (hasGit) {
                    this.setupWorkspaces.add(wsName);
                    try {
                        const result = await this.runInternal('workspaces', 'setup', { workspace: wsName });
                        if (result?.content && !result.content.startsWith('Tool not found')) {
                            setupPreamble = result.content
                                + '\n\n> **Hint:** If you have native file tools (Read/Glob/Grep), use them at the workspace path above — faster than open().\n\n---\n\n';
                        }
                    } catch {
                        // Setup failed — continue with file content anyway
                    }
                }
            }
        }

        // Workspace activation: clone into workspace/ on WORKSPACE.md read
        const wsMatch = filePath.match(/^workspaces\/(.+?)\/WORKSPACE\.md$/);
        if (wsMatch) {
            const segments = wsMatch[1].split('/');
            await this.activateWorkspace(segments[segments.length - 1]);
        }

        const content = await fs.readFile(resolved, 'utf-8');
        return setupPreamble + content;
    }

    // ─── run ───────────────────────────────────────────────
    // Execute a skill tool. No activation gate — resolve, check scopes, execute.

    async run(skill: string, tool: string, params?: Record<string, unknown>): Promise<ToolResult> {
        const ref = this.ernesto.skills.resolveTool(`${skill}:${tool}`);
        if (!ref) return { content: `Tool not found: ${skill}:${tool}` };

        // Scope check
        const skillDef = this.ernesto.skills.get(skill);
        const required = [
            ...(skillDef?.requiredScopes ?? []),
            ...(ref.tool.requiredScopes ?? []),
        ];
        const missing = required.filter(s => !this.user.scopes?.includes(s));
        if (missing.length) return { content: `Missing scopes: ${missing.join(', ')}` };

        const validated = ref.tool.inputSchema
            ? ref.tool.inputSchema.parse(params ?? {})
            : params ?? {};
        return ref.tool.execute(validated, this.ctx());
    }

    // ─── settle ────────────────────────────────────────────

    async settle(message: string): Promise<SettleResult> {
        if (!this.workspaceOps) {
            return { status: 'error', summary: 'No workspace provider configured' };
        }

        const workspacePath = path.join(this.path, 'workspace');
        const hasWorkspace = await fs.stat(workspacePath).catch(() => null);
        if (!hasWorkspace) {
            return { status: 'error', summary: 'No active workspace. Read a WORKSPACE.md first.' };
        }

        return this.workspaceOps.settle(workspacePath, message, {
            sessionId: this.id,
            user: this.user.email,
            workflow: 'session',
        });
    }

    // ─── MCP registration ──────────────────────────────────

    attachToMcpServer(server: McpServer): void {
        const self = this;

        server.registerTool('open', {
            description: [
                'Browse or read from your Ernesto session.',
                'No path = overview of workspaces.',
                'Reading a WORKSPACE.md mounts it for editing.',
                'For general file reading, use native Read/Glob/Grep tools instead — they are faster.',
            ].join(' '),
            inputSchema: z.object({
                path: z.string().optional().describe('File or directory path relative to session root'),
            }),
        }, async ({ path: p }) => ({
            content: [{ type: 'text' as const, text: await self.open(p) }],
        }));

        server.registerTool('run', {
            description: 'Execute a skill tool.',
            inputSchema: z.object({
                skill: z.string().describe('Skill name (e.g. "app-logs", "redshift")'),
                tool: z.string().describe('Tool name within the skill'),
                params: z.record(z.string(), z.unknown()).optional().describe('Tool parameters as key-value pairs'),
            }),
        }, async ({ skill, tool, params }) => {
            const result = await self.run(skill, tool, params);
            return { content: [{ type: 'text' as const, text: result.content }] };
        });

        server.registerTool('write', {
            description: 'Write a file to the active workspace. Only files under workspace/ or workspaces/ can be written.',
            inputSchema: z.object({
                path: z.string().describe('Path within workspace/ or workspaces/'),
                content: z.string().describe('File content to write'),
            }),
        }, async ({ path: p, content }) => {
            if (!p.startsWith('workspace/') && !p.startsWith('workspaces/')) {
                return { content: [{ type: 'text' as const, text: 'Write restricted to workspace/ or workspaces/' }] };
            }
            const resolved = self.resolve(p);
            await fs.mkdir(path.dirname(resolved), { recursive: true });
            await fs.writeFile(resolved, content, 'utf-8');
            return { content: [{ type: 'text' as const, text: `Written: ${p}` }] };
        });

        server.registerTool('settle', {
            description: 'Commit and push workspace changes. Requires an active workspace.',
            inputSchema: z.object({
                message: z.string().describe('Commit message describing the changes'),
            }),
        }, async ({ message }) => {
            const result = await self.settle(message);
            if (result.status === 'conflict') {
                return { content: [{ type: 'text' as const, text: `Conflict:\n${result.conflicts?.join('\n') ?? 'unknown'}` }] };
            }
            return { content: [{ type: 'text' as const, text: `Settled: ${result.commit ?? 'done'}\n${result.summary ?? ''}` }] };
        });
    }

    // ─── Private ───────────────────────────────────────────

    private extractWorkspaceName(filePath: string): string | null {
        if (!filePath.startsWith('workspaces/')) return null;
        const parts = filePath.split('/');
        let wsName: string | null = null;
        for (let i = 0; i < parts.length - 1; i++) {
            if (parts[i] === 'workspaces' && i + 1 < parts.length && parts[i + 1] !== 'workspaces') {
                wsName = parts[i + 1];
            }
        }
        return wsName;
    }

    private resolveWorkspaceRoot(filePath: string): string | null {
        const parts = filePath.split('/');
        let lastWsIndex = -1;
        for (let i = 0; i < parts.length - 1; i++) {
            if (parts[i] === 'workspaces' && i + 1 < parts.length && parts[i + 1] !== 'workspaces') {
                lastWsIndex = i + 1;
            }
        }
        if (lastWsIndex === -1) return null;
        return this.resolve(parts.slice(0, lastWsIndex + 1).join('/'));
    }

    private async runInternal(skill: string, tool: string, params?: Record<string, unknown>): Promise<ToolResult> {
        const ref = this.ernesto.skills.resolveTool(`${skill}:${tool}`);
        if (!ref) return { content: `Tool not found: ${skill}:${tool}` };

        const validated = ref.tool.inputSchema
            ? ref.tool.inputSchema.parse(params ?? {})
            : params ?? {};
        return ref.tool.execute(validated, this.ctx());
    }

    private async activateWorkspace(wsName: string): Promise<void> {
        const wsActive = path.join(this.path, 'workspace');
        if (await fs.stat(wsActive).catch(() => null)) return;
        if (this.workspaceOps) {
            await this.workspaceOps.setup(wsName, wsActive);
        }
    }

    private resolve(filePath: string): string {
        const resolved = path.resolve(this.path, filePath);
        if (!resolved.startsWith(this.path)) {
            throw new Error('Access denied: path outside session');
        }
        return resolved;
    }

    private ctx(): ToolContext {
        return {
            user: this.user,
            scopes: this.user.scopes,
            timestamp: Date.now(),
            ernesto: this.ernesto,
        };
    }

    private async overview(): Promise<string> {
        const lines: string[] = ['# Ernesto Session', ''];

        const wsDir = path.join(this.path, 'workspaces');
        const workspaces = await fs.readdir(wsDir).catch(() => [] as string[]);
        if (workspaces.length) {
            lines.push('## Workspaces');
            for (const ws of workspaces.sort()) {
                const wsMd = path.join(wsDir, ws, 'WORKSPACE.md');
                const metaFile = path.join(wsDir, ws, '.meta');
                let summary = '';
                const hasWsMd = await fs.stat(wsMd).catch(() => null);
                if (hasWsMd) {
                    try {
                        const content = await fs.readFile(wsMd, 'utf-8');
                        summary = content.split('\n')[0].replace(/^#+ */, '');
                    } catch {}
                    lines.push(`- **${ws}** — ${summary} [expanded]`);
                } else {
                    try {
                        summary = (await fs.readFile(metaFile, 'utf-8')).trim();
                    } catch {}
                    lines.push(`- **${ws}** — ${summary || '(not expanded)'}`);
                }
            }
        }

        lines.push('', '## How to use');
        lines.push('');
        lines.push('1. **Browse workspaces:** `open("workspaces/")` — see available domains and projects');
        lines.push('2. **Expand workspace:** `open("workspaces/{name}/WORKSPACE.md")` — clone and activate');
        lines.push('3. **Run tools:** `run("{skill}", "{tool}", {params})` — execute domain tools');
        lines.push('4. **Edit & save:** Write files → `settle("description of changes")`');

        return lines.join('\n');
    }
}
