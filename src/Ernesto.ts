/**
 * Ernesto — Filesystem-Based Agent Intelligence
 *
 * Skills, resources, and workspaces are all folders with files.
 * The Ernesto class manages:
 * - Master FS: shared reference filesystem (skills + resources + workspaces)
 * - Sessions: per-user filesystem with scoped symlinks + progressive disclosure
 * - Content pipelines: index to Typesense AND write to master FS as files
 */

import { Skill } from './skill';
import { SkillRegistry, SkillSnapshot } from './skill-registry';
import { Soul } from './soul';
import { HeartbeatConfig } from './heartbeat';
import debug from 'debug';
import { ContentPipeline } from './pipelines';
import { ResourceNode, DEFAULT_CACHE_TTL_MS, PipelineConfig } from './types';
import { deleteSourceDocuments, getSourceFreshness, indexMcpResources } from './typesense/client';
import { McpResourceDocument } from './typesense/schema';
import { Client as TypesenseClient } from 'typesense';
import { LifecycleService } from './LifecycleService';
import { truncateText, flattenResources } from './utils';
import { Session, SessionUser, WorkspaceProvider } from './Session';
import { formatZodSchemaForAgent } from './schema-formatter';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { tmpdir } from 'os';

const log = debug('Ernesto');

const DEFAULT_MASTER_FS = path.join(tmpdir(), 'ernesto', 'ref');
const DEFAULT_SESSIONS_DIR = path.join(tmpdir(), 'ernesto', 'sessions');
const DEFAULT_USERS_DIR = path.join(tmpdir(), 'ernesto', 'users');

/**
 * Workspace operations provider — implemented by backend, injected at construction.
 */
export type { WorkspaceProvider } from './Session';

/**
 * Extended workspace operations (list + checkout + create) for master FS materialization.
 */
export interface FullWorkspaceProvider extends WorkspaceProvider {
    list(): Promise<string[]>;
    checkout(branch: string, targetPath: string): Promise<void>;
    create(name: string, description: string): Promise<void>;
}

interface ErnestoOptions {
    skills?: Skill[];
    skillRegistry?: SkillRegistry;
    typesense: TypesenseClient;
    soul?: Soul;
    heartbeat?: HeartbeatConfig;
    /** Workspace git operations (setup, settle, list, checkout, create) */
    workspaceOps?: FullWorkspaceProvider;
    /** Override master FS path (default: $TMPDIR/ernesto/ref) */
    masterFsPath?: string;
    /** Override sessions directory (default: $TMPDIR/ernesto/sessions) */
    sessionsPath?: string;
    /** Override per-user workspace directory (default: $TMPDIR/ernesto/users) */
    usersPath?: string;
    /** Path to script templates for session FS (open.sh, run.sh, settle.sh) */
    scriptsPath?: string;
}

/**
 * Serializable snapshot of Ernesto state (for dashboard)
 */
export interface ErnestoSnapshot {
    skills: SkillSnapshot[];
    toolCount: number;
    soul: Soul | null;
    heartbeat: HeartbeatConfig | null;
}

/**
 * Ernesto — filesystem-based agent intelligence system.
 *
 * Replaces ask/get with a filesystem. Skills = SKILL.md + .sh scripts.
 * Resources = files. Workspaces = git checkouts. Everything grepable.
 */
export class Ernesto {
    // ─── Core ────────────────────────────────────────────────────────────
    readonly skillRegistry: SkillRegistry;
    readonly typesense: TypesenseClient;
    readonly lifecycle = new LifecycleService(this);

    // ─── OpenClaw Primitives ─────────────────────────────────────────────
    private _soul: Soul | null = null;
    private _heartbeat: HeartbeatConfig | null = null;

    // ─── Filesystem session system ───────────────────────────────────────
    private _masterFSReady = false;
    private _workspaceOps?: FullWorkspaceProvider;
    readonly masterFsPath: string;
    readonly sessionsPath: string;
    readonly usersPath: string;
    private _scriptsPath?: string;

    constructor(opts: ErnestoOptions) {
        this.typesense = opts.typesense;

        if (opts.skillRegistry) {
            this.skillRegistry = opts.skillRegistry;
        } else {
            this.skillRegistry = new SkillRegistry();
            if (opts.skills?.length) {
                this.skillRegistry.registerAll(opts.skills);
            }
        }

        this._soul = opts.soul ?? null;
        this._heartbeat = opts.heartbeat ?? null;
        this.masterFsPath = opts.masterFsPath ?? DEFAULT_MASTER_FS;
        this.sessionsPath = opts.sessionsPath ?? DEFAULT_SESSIONS_DIR;
        this.usersPath = opts.usersPath ?? DEFAULT_USERS_DIR;
        this._workspaceOps = opts.workspaceOps;
        this._scriptsPath = opts.scriptsPath;
    }

    // ============================================================
    // PUBLIC ACCESSORS
    // ============================================================

    get skills(): SkillRegistry {
        return this.skillRegistry;
    }

    get soul(): Soul | null {
        return this._soul;
    }

    get heartbeat(): HeartbeatConfig | null {
        return this._heartbeat;
    }

    public toJSON(): ErnestoSnapshot {
        return {
            skills: this.skillRegistry.toJSON(),
            toolCount: this.skillRegistry.getAllTools().length,
            soul: this._soul,
            heartbeat: this._heartbeat,
        };
    }

    // ============================================================
    // CONTENT PIPELINE INITIALIZATION
    // ============================================================

    public async initialize(): Promise<void> {
        const startTime = Date.now();
        log('Initializing...');

        const stats = { fresh: 0, fetched: 0, failed: 0 };

        for (const skill of this.skillRegistry.getAll()) {
            if (!skill.resources) continue;

            for (const extractor of skill.resources) {
                try {
                    const result = await this.initializeSource(skill.name, extractor);
                    result.wasFresh ? stats.fresh++ : stats.fetched++;
                } catch (error) {
                    log('Failed to initialize source', {
                        skill: skill.name,
                        source: extractor.source.name,
                        error,
                    });
                    stats.failed++;
                }
            }
        }

        log('Initialization complete', {
            duration: Date.now() - startTime,
            skills: this.skillRegistry.getAll().length,
            tools: this.skillRegistry.getAllTools().length,
            ...stats,
        });
    }

    private async initializeSource(skillName: string, extractor: PipelineConfig): Promise<{ wasFresh: boolean }> {
        const pipeline = new ContentPipeline({
            source: extractor.source,
            formats: extractor.formats,
            basePath: extractor.basePath,
        });
        const sourceId = pipeline.sourceId;
        const ttlMs = extractor.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
        const isLocal = extractor.source.name.startsWith('local:');

        if (!isLocal) {
            const freshness = await getSourceFreshness(this, sourceId);
            if (freshness && freshness.ageMs < ttlMs) {
                log('Source fresh, skipping', { sourceId, ageMinutes: Math.round(freshness.ageMs / 60000) });
                return { wasFresh: true };
            }
        }

        await this.fetchAndIndexSource(pipeline, sourceId, skillName, extractor);
        return { wasFresh: false };
    }

    private async fetchAndIndexSource(
        pipeline: ContentPipeline,
        sourceId: string,
        skillName: string,
        extractor: PipelineConfig,
    ): Promise<void> {
        const resources = await pipeline.fetchResources();
        if (resources.length === 0) {
            log('No resources from source', { sourceId });
            return;
        }

        await deleteSourceDocuments(this, sourceId);
        await this.indexResources(sourceId, skillName, extractor, resources);

        // Also write resources as files to master FS
        await this.writeResourcesToFS(skillName, resources).catch(err => {
            log('Failed to write resources to FS (non-fatal)', { skillName, error: err });
        });

        log('Indexed source', { sourceId, skillName, resourceCount: resources.length });
    }

    public async indexResources(
        sourceId: string,
        skillName: string,
        pipelineConfig: PipelineConfig,
        resources: ResourceNode[],
    ): Promise<void> {
        const skill = this.skillRegistry.get(skillName);
        const parentScopes = skill?.requiredScopes || [];
        const pipelineScopes = pipelineConfig.scopes || [];
        const mergedScopes = [...new Set([...parentScopes, ...pipelineScopes])];

        const flatResources = flattenResources(resources);

        const documents: McpResourceDocument[] = flatResources.map((resource) => {
            const resourcePath = resource.path.startsWith('/') ? resource.path.slice(1) : resource.path;
            const uri = `${skillName}://resources/${resourcePath}`;
            const description = truncateText(resource.description || resource.content);
            const resourceScopes = resource.metadata?.scopes;
            const finalScopes = resourceScopes !== undefined ? resourceScopes : mergedScopes;

            return {
                id: Buffer.from(uri).toString('base64'),
                uri,
                domain: skillName,
                path: resourcePath,
                source_id: sourceId,
                name: resource.name,
                content: resource.content,
                scopes: finalScopes,
                is_unrestricted: finalScopes.length === 0,
                description,
                content_size: resource.content.length,
                child_count: resource.children?.length || 0,
                resource_type: resource.metadata?.resource_type || 'resource',
                path_segment: resourcePath.split('/')[0] || '',
                quality_score: resource.metadata?.quality_score ?? 50,
                indexed_at: Date.now(),
            };
        });

        await indexMcpResources(this, documents);
    }

    // ============================================================
    // FILESYSTEM SESSION SYSTEM
    // ============================================================

    /**
     * Ensure the master reference FS is materialized.
     * Idempotent — writes skills, resources, and workspaces to disk once.
     */
    async ensureMasterFS(): Promise<void> {
        if (this._masterFSReady) return;
        await this.materializeSkills();
        await this.materializeResources();
        await this.materializeWorkspaces();
        this._masterFSReady = true;
        log('Master FS materialized', { path: this.masterFsPath });
    }

    /**
     * Create a new session for a user.
     *
     * Uses a **per-user workspace** — a persistent directory that survives across
     * sessions. Skills are symlinked once at the root; sub-workspaces live under
     * `workspaces/` as nested directories (each backed by a git branch).
     *
     * Falls back to a per-session ephemeral FS when no user ID is available.
     */
    async createSession(user: SessionUser, opts?: { workspace?: string }): Promise<Session> {
        await this.ensureMasterFS();
        const id = crypto.randomUUID();

        let sessionPath: string;
        if (user.id) {
            // Per-user workspace — persistent, shared across sessions
            sessionPath = this.getUserWorkspacePath(user.id);
            await this.ensureUserWorkspace(sessionPath, user);
        } else {
            // Fallback: ephemeral per-session FS
            sessionPath = path.join(this.sessionsPath, id);
            await this.buildSessionFS(sessionPath, user);
        }

        if (opts?.workspace && this._workspaceOps) {
            await this._workspaceOps.setup(opts.workspace, path.join(sessionPath, 'workspace'));
        }

        return new Session(this, id, sessionPath, user, this._workspaceOps);
    }

    /**
     * Get the filesystem path for a user's workspace.
     */
    getUserWorkspacePath(userId: string): string {
        return path.join(this.usersPath, userId);
    }

    // ─── Master FS: Skills ──────────────────────────────────────────

    private async materializeSkills(): Promise<void> {
        for (const skill of this.skillRegistry.getAll()) {
            const dir = path.join(this.masterFsPath, 'skills', skill.slug);
            const refs = path.join(dir, 'references');
            await fs.mkdir(refs, { recursive: true });

            const instruction = typeof skill.instruction === 'function'
                ? await skill.instruction({ ernesto: this })
                : skill.instruction;

            const toolDocs = skill.tools.map(t => {
                const params = t.inputSchema ? formatZodSchemaForAgent(t.inputSchema) : '';
                return `- **${t.name}**: ${t.description}${params ? `\n  Parameters: ${params}` : ''}`;
            }).join('\n');

            await fs.writeFile(
                path.join(dir, 'SKILL.md'),
                `${instruction}\n\n## Tools\n\n${toolDocs}\n`,
            );

            for (const tool of skill.tools) {
                await fs.writeFile(
                    path.join(refs, `${tool.name}.sh`),
                    generateToolScript(skill.slug, tool),
                    { mode: 0o755 },
                );
            }
        }

        log('Skills materialized', {
            count: this.skillRegistry.getAll().length,
            path: path.join(this.masterFsPath, 'skills'),
        });
    }

    // ─── Master FS: Workspaces ──────────────────────────────────────

    private async materializeWorkspaces(): Promise<void> {
        if (!this._workspaceOps) {
            log('No workspace provider — skipping workspace materialization');
            return;
        }

        const wsBase = path.join(this.masterFsPath, 'workspaces');
        await fs.mkdir(wsBase, { recursive: true });

        const branches = await this._workspaceOps.list();
        for (const branch of branches) {
            if (branch === 'main' || branch === 'master') continue;
            const wsDir = path.join(wsBase, branch);
            try {
                await this._workspaceOps.checkout(branch, wsDir);
            } catch (err) {
                log('Failed to checkout workspace branch', { branch, error: err });
            }
        }

        log('Workspaces materialized', { count: branches.length, path: wsBase });
    }

    // ─── Master FS: Resources ───────────────────────────────────────

    private async materializeResources(): Promise<void> {
        await fs.mkdir(path.join(this.masterFsPath, 'resources'), { recursive: true });
    }

    /**
     * Write content pipeline resources as files to the master FS.
     */
    async writeResourcesToFS(skillName: string, resources: ResourceNode[]): Promise<void> {
        const baseDir = path.join(this.masterFsPath, 'resources', skillName);
        const flat = flattenResources(resources);

        for (const resource of flat) {
            const resourcePath = resource.path.startsWith('/') ? resource.path.slice(1) : resource.path;
            const filePath = path.join(baseDir, `${resourcePath}.md`);
            await fs.mkdir(path.dirname(filePath), { recursive: true });
            await fs.writeFile(filePath, resource.content, 'utf-8');
        }
    }

    // ─── User Workspace ───────────────────────────────────────────────

    /**
     * Ensure a per-user workspace exists and is up to date.
     * Idempotent — safe to call on every session start.
     *
     * Creates:
     *   {userPath}/
     *   ├── skills/          ← symlinks to master FS (all accessible, scope-filtered)
     *   ├── workspaces/      ← sub-workspace stubs and expanded clones
     *   └── WORKSPACE.md     ← root workspace instruction (auto-generated)
     */
    private async ensureUserWorkspace(userPath: string, user: SessionUser): Promise<void> {
        await fs.mkdir(path.join(userPath, 'skills'), { recursive: true });
        await fs.mkdir(path.join(userPath, 'workspaces'), { recursive: true });

        // Symlink accessible skills (idempotent — skip existing)
        for (const skill of this.accessibleSkills(user)) {
            const skillDir = path.join(userPath, 'skills', skill.slug);
            const skillMdLink = path.join(skillDir, 'SKILL.md');
            // Skip if symlink already exists
            if (await fs.stat(skillMdLink).catch(() => null)) continue;
            await fs.mkdir(skillDir, { recursive: true });
            await fs.symlink(
                path.join(this.masterFsPath, 'skills', skill.slug, 'SKILL.md'),
                skillMdLink,
            ).catch(() => {});
        }

        // Symlink resources from master FS (idempotent)
        const resDir = path.join(userPath, 'resources');
        await fs.mkdir(resDir, { recursive: true });
        const domains = await fs.readdir(path.join(this.masterFsPath, 'resources')).catch(() => [] as string[]);
        for (const domain of domains) {
            const link = path.join(resDir, domain);
            if (await fs.stat(link).catch(() => null)) continue;
            await fs.symlink(
                path.join(this.masterFsPath, 'resources', domain),
                link,
            ).catch(() => {});
        }

        // Copy script templates if configured
        if (this._scriptsPath) {
            for (const script of ['open.sh', 'run.sh', 'settle.sh']) {
                const dest = path.join(userPath, script);
                if (await fs.stat(dest).catch(() => null)) continue;
                const src = path.join(this._scriptsPath, script);
                try {
                    await fs.copyFile(src, dest);
                    await fs.chmod(dest, 0o755);
                } catch {}
            }
        }

        log('User workspace ready', { userId: user.id, path: userPath });
    }

    // ─── Session FS (legacy — fallback for sessions without user ID) ────

    private async buildSessionFS(sessionPath: string, user: SessionUser): Promise<void> {
        for (const skill of this.accessibleSkills(user)) {
            const skillDir = path.join(sessionPath, 'skills', skill.slug);
            await fs.mkdir(skillDir, { recursive: true });
            await fs.symlink(
                path.join(this.masterFsPath, 'skills', skill.slug, 'SKILL.md'),
                path.join(skillDir, 'SKILL.md'),
            ).catch(() => {});
        }

        await fs.mkdir(path.join(sessionPath, 'resources'), { recursive: true });
        const domains = await fs.readdir(path.join(this.masterFsPath, 'resources')).catch(() => [] as string[]);
        for (const domain of domains) {
            await fs.symlink(
                path.join(this.masterFsPath, 'resources', domain),
                path.join(sessionPath, 'resources', domain),
            ).catch(() => {});
        }

        const wsBase = path.join(this.masterFsPath, 'workspaces');
        await fs.mkdir(path.join(sessionPath, 'workspaces'), { recursive: true });
        const workspaces = await fs.readdir(wsBase).catch(() => [] as string[]);
        for (const ws of workspaces) {
            await fs.symlink(
                path.join(wsBase, ws),
                path.join(sessionPath, 'workspaces', ws),
            ).catch(() => {});
        }

        if (this._scriptsPath) {
            for (const script of ['open.sh', 'run.sh', 'settle.sh']) {
                const src = path.join(this._scriptsPath, script);
                const dest = path.join(sessionPath, script);
                try {
                    await fs.copyFile(src, dest);
                    await fs.chmod(dest, 0o755);
                } catch (err) {
                    log('Failed to copy script', { script, error: err });
                }
            }
        }

        await fs.writeFile(path.join(sessionPath, '.session'), crypto.randomUUID());
    }

    private accessibleSkills(user: SessionUser): Skill[] {
        return this.skillRegistry.getAll().filter(s => {
            if (s.enabled === false) return false;
            if (!s.requiredScopes?.length) return true;
            return s.requiredScopes.every(sc => user.scopes?.includes(sc));
        });
    }
}

// ─── Tool Script Generator ──────────────────────────────────────────────

function generateToolScript(skill: string, tool: { name: string; description: string }): string {
    return `#!/usr/bin/env bash
# ${tool.name} — ${skill}
# ${tool.description}
#
# Run with no args to see parameter docs.
#
set -euo pipefail
ERNESTO_URL="\${ERNESTO_URL:-http://localhost:3002}"
PARAMS="\${1:-}"
[ -z "\$PARAMS" ] && { sed -n '/^#[^!]/p' "\$0"; exit 0; }
curl -sf \\
  -H "Authorization: Bearer \${ERNESTO_TOKEN}" \\
  -H "Content-Type: application/json" \\
  -X POST -d "\$PARAMS" \\
  "\$ERNESTO_URL/ernesto/http/tools/${skill}/${tool.name}" | jq .
`;
}
