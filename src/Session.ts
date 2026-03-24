/**
 * Session — Filesystem-based agent session
 *
 * Each session is a folder with symlinks to the master FS.
 * Progressive disclosure: reading SKILL.md symlinks references/ (activates tools),
 * reading WORKSPACE.md mounts a writable git clone at workspace/.
 *
 * Tier 1 (bash agents): Use open.sh, run.sh, settle.sh scripts directly.
 * Tier 2 (MCP agents): Use this class via open(), run(), write(), settle() MCP tools.
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
    // Browse, read, and activate skills/workspaces.
    // Same logic as open.sh, but in TypeScript for Tier 2 agents.

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

        const content = await fs.readFile(resolved, 'utf-8');

        // Progressive disclosure: skill activation
        const skillMatch = filePath.match(/^skills\/([^/]+)\/SKILL\.md$/);
        if (skillMatch) {
            const slug = skillMatch[1];
            await this.activateSkill(slug);
        }

        // Progressive disclosure: workspace activation
        const wsMatch = filePath.match(/^workspaces\/([^/]+)\/WORKSPACE\.md$/);
        if (wsMatch) {
            const wsName = wsMatch[1];
            await this.activateWorkspace(wsName);
        }

        return content;
    }

    // ─── run ───────────────────────────────────────────────
    // Execute a skill tool. Skill must be activated first.

    async run(skill: string, tool: string, params?: Record<string, unknown>): Promise<ToolResult> {
        // Check activation: does references/ exist in session FS?
        const refsDir = path.join(this.path, 'skills', skill, 'references');
        const activated = await fs.stat(refsDir).catch(() => null);

        if (!activated) {
            const hasSkill = await fs.stat(
                path.join(this.path, 'skills', skill, 'SKILL.md')
            ).catch(() => null);
            if (hasSkill) {
                return { content: `Skill '${skill}' not activated. Read it first: open("skills/${skill}/SKILL.md")` };
            }
            return { content: `Skill not found: ${skill}` };
        }

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
    // Commit and push workspace changes.

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
    // Attach 4 tools to an MCP server for Tier 2 agents.

    attachToMcpServer(server: McpServer): void {
        const self = this;

        server.registerTool('open', {
            description: [
                'Browse or read from your Ernesto session.',
                'No path = overview of skills, resources, workspaces.',
                'Reading a SKILL.md activates that skill\'s tools.',
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
            description: 'Execute a skill tool. Skill must be activated first (read its SKILL.md via open).',
            inputSchema: z.object({
                skill: z.string().describe('Skill name (e.g. "app-logs", "redshift")'),
                tool: z.string().describe('Tool name within the skill'),
                params: z.record(z.string(), z.unknown()).optional().describe('Tool parameters as key-value pairs'),
            }),
        }, async ({ skill, tool, params }) => {
            const result = await self.run(skill, tool, params);
            return { content: [{ type: 'text' as const, text: result.content }] };
        });

        // Tier 2 agents have no native Write — they need this to edit workspace files
        server.registerTool('write', {
            description: 'Write a file to the active workspace. Only files under workspace/ can be written.',
            inputSchema: z.object({
                path: z.string().describe('Path within workspace/ (e.g. "workspace/context/notes.md")'),
                content: z.string().describe('File content to write'),
            }),
        }, async ({ path: p, content }) => {
            if (!p.startsWith('workspace/')) {
                return { content: [{ type: 'text' as const, text: 'Write restricted to workspace/' }] };
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

    // ─── Private: Activation ───────────────────────────────

    private async activateSkill(slug: string): Promise<void> {
        const refsLink = path.join(this.path, 'skills', slug, 'references');
        if (await fs.stat(refsLink).catch(() => null)) return; // Already active

        const skillMdPath = path.join(this.path, 'skills', slug, 'SKILL.md');
        const skillMdTarget = await fs.readlink(skillMdPath).catch(() => null);
        if (!skillMdTarget) return;

        const masterSkillDir = path.dirname(skillMdTarget);
        const masterRefs = path.join(masterSkillDir, 'references');
        if (await fs.stat(masterRefs).catch(() => null)) {
            await fs.symlink(masterRefs, refsLink).catch(() => {});
        }
    }

    private async activateWorkspace(wsName: string): Promise<void> {
        const wsActive = path.join(this.path, 'workspace');
        if (await fs.stat(wsActive).catch(() => null)) return; // Already has active workspace

        if (this.workspaceOps) {
            await this.workspaceOps.setup(wsName, wsActive);
        }
    }

    // ─── Private: Path resolution ──────────────────────────

    private resolve(filePath: string): string {
        const resolved = path.resolve(this.path, filePath);
        if (!resolved.startsWith(this.path)) {
            throw new Error('Access denied: path outside session');
        }
        return resolved;
    }

    // ─── Private: Tool context ─────────────────────────────

    private ctx(): ToolContext {
        return {
            user: this.user,
            scopes: this.user.scopes,
            timestamp: Date.now(),
            ernesto: this.ernesto,
        };
    }

    // ─── Private: Overview ─────────────────────────────────

    private async overview(): Promise<string> {
        const lines: string[] = ['# Ernesto Session', ''];

        // Skills
        const skillsDir = path.join(this.path, 'skills');
        const slugs = await fs.readdir(skillsDir).catch(() => [] as string[]);
        lines.push(`## Skills (${slugs.length})`);
        for (const slug of slugs.sort()) {
            const hasRefs = await fs.stat(path.join(skillsDir, slug, 'references')).catch(() => null);
            const skill = this.ernesto.skills.get(slug);
            const desc = skill?.description ?? '';
            lines.push(`- **${slug}**${hasRefs ? ' [active]' : ''} — ${desc}`);
        }

        // Resources
        const resDir = path.join(this.path, 'resources');
        const domains = await fs.readdir(resDir).catch(() => [] as string[]);
        if (domains.length) {
            lines.push('', '## Resources');
            for (const d of domains.sort()) lines.push(`- ${d}/`);
        }

        // Workspaces (browsable, read-only)
        const wsDir = path.join(this.path, 'workspaces');
        const workspaces = await fs.readdir(wsDir).catch(() => [] as string[]);
        if (workspaces.length) {
            lines.push('', '## Workspaces');
            for (const ws of workspaces.sort()) {
                const wsMd = path.join(wsDir, ws, 'WORKSPACE.md');
                let summary = '';
                try {
                    const content = await fs.readFile(wsMd, 'utf-8');
                    summary = content.split('\n')[0].replace(/^#+ */, '');
                } catch {}
                lines.push(`- **${ws}** — ${summary}`);
            }
        }

        // Active workspace
        const hasActive = await fs.stat(path.join(this.path, 'workspace', 'WORKSPACE.md')).catch(() => null);
        if (hasActive) {
            lines.push('', '## Active Workspace', 'Mounted at `workspace/` (writable).');
        }

        lines.push('', '## Usage');
        lines.push('1. `open("skills/{name}/SKILL.md")` — activate a skill');
        lines.push('2. `open("workspaces/{name}/WORKSPACE.md")` — activate a workspace');
        lines.push('3. `run("{name}", "{tool}", {params})` — execute a tool');
        lines.push('4. Edit workspace files with `write("workspace/path", content)`');
        lines.push('5. `settle("message")` — commit + push');
        lines.push('6. Search everything with grep across the session directory');

        return lines.join('\n');
    }
}
