/**
 * Ernesto — Skill Registry & Session Factory
 *
 * The Ernesto class is the entry point for deployers:
 * 1. Register skills (instruction + tools + resources)
 * 2. Create sessions for agents
 * 3. Optionally provide search and workspace capabilities
 *
 * The class is deliberately minimal. Filesystem setup, content extraction,
 * and search indexing are the deployer's responsibility. Ernesto provides
 * the primitives — the deployer composes them.
 */

import { Skill } from './skill';
import { SkillRegistry, SkillSnapshot } from './skill-registry';
import { Soul } from './soul';
import { Session, SessionUser, WorkspaceProvider } from './Session';
import { SearchProvider } from './search';
import * as crypto from 'crypto';
import * as path from 'path';
import { tmpdir } from 'os';

export type { WorkspaceProvider } from './Session';

const DEFAULT_USERS_DIR = path.join(tmpdir(), 'ernesto', 'users');

interface ErnestoOptions {
    /** Skills to register (alternative to providing a SkillRegistry) */
    skills?: Skill[];
    /** Pre-built skill registry (alternative to providing skills array) */
    skillRegistry?: SkillRegistry;
    /** Agent persona */
    soul?: Soul;
    /** Workspace git operations (setup/settle) — optional */
    workspaceOps?: WorkspaceProvider;
    /** Search provider — optional, deployer implements */
    search?: SearchProvider;
    /** Base directory for per-user workspaces (default: $TMPDIR/ernesto/users) */
    usersPath?: string;
}

/**
 * Serializable snapshot of Ernesto state (for dashboards)
 */
export interface ErnestoSnapshot {
    skills: SkillSnapshot[];
    toolCount: number;
    soul: Soul | null;
}

export class Ernesto {
    readonly skillRegistry: SkillRegistry;
    readonly search?: SearchProvider;
    readonly usersPath: string;

    private _soul: Soul | null = null;
    private _workspaceOps?: WorkspaceProvider;

    constructor(opts: ErnestoOptions) {
        if (opts.skillRegistry) {
            this.skillRegistry = opts.skillRegistry;
        } else {
            this.skillRegistry = new SkillRegistry();
            if (opts.skills?.length) {
                this.skillRegistry.registerAll(opts.skills);
            }
        }

        this._soul = opts.soul ?? null;
        this._workspaceOps = opts.workspaceOps;
        this.search = opts.search;
        this.usersPath = opts.usersPath ?? DEFAULT_USERS_DIR;
    }

    // ─── Accessors ────────────────────────────────────────────────

    get skills(): SkillRegistry { return this.skillRegistry; }
    get soul(): Soul | null { return this._soul; }

    // ─── Sessions ─────────────────────────────────────────────────

    /**
     * Get the filesystem path for a user's workspace.
     */
    getUserWorkspacePath(userId: string): string {
        return path.join(this.usersPath, userId);
    }

    /**
     * Create a new session for a user.
     *
     * The session path defaults to the user's persistent workspace.
     * Override with opts.path for custom directory layouts.
     *
     * Note: The deployer is responsible for ensuring the session directory
     * exists and is populated (workspace stubs, etc.) before the agent
     * interacts with it.
     */
    async createSession(
        user: SessionUser,
        opts?: { path?: string; workspace?: string },
    ): Promise<Session> {
        const id = crypto.randomUUID();
        const sessionPath = opts?.path
            ?? (user.id
                ? this.getUserWorkspacePath(user.id)
                : path.join(this.usersPath, '__ephemeral__', id));

        // Pre-clone a workspace if requested
        if (opts?.workspace && this._workspaceOps) {
            await this._workspaceOps.setup(opts.workspace, path.join(sessionPath, 'workspace'));
        }

        return new Session(this, id, sessionPath, user, this._workspaceOps);
    }

    // ─── Snapshot ─────────────────────────────────────────────────

    toJSON(): ErnestoSnapshot {
        return {
            skills: this.skillRegistry.toJSON(),
            toolCount: this.skillRegistry.getAllTools().length,
            soul: this._soul,
        };
    }
}
