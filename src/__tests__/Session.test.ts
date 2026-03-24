/**
 * Session — comprehensive unit + integration tests
 *
 * Tests progressive disclosure, tool execution, workspace activation,
 * path security, and MCP registration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { Session, SessionUser, WorkspaceProvider } from '../Session';
import { Ernesto } from '../Ernesto';
import { createSkill, createTool, toolResult } from '../skill';
import { z } from 'zod';

// ─── Helpers ────────────────────────────────────────────────────────────

const TEST_BASE = path.join(tmpdir(), 'ernesto-test', `session-${Date.now()}`);
let masterFs: string;
let sessionPath: string;
let ernesto: Ernesto;

function mockTypesense(): any {
    const mockSearch = vi.fn().mockResolvedValue({ hits: [], found: 0 });
    const mockImport = vi.fn().mockResolvedValue([]);
    const mockDelete = vi.fn().mockResolvedValue({ num_deleted: 0 });
    const docs = vi.fn(() => ({ search: mockSearch, import: mockImport, delete: mockDelete }));
    const collections = vi.fn(() => ({
        retrieve: vi.fn().mockResolvedValue({}),
        documents: docs,
    }));
    return { collections } as any;
}

const echoTool = createTool({
    name: 'echo',
    description: 'Echoes the input',
    inputSchema: z.object({ message: z.string() }),
    execute: async ({ message }) => ({ content: `Echo: ${message}` }),
});

const secretTool = createTool({
    name: 'secret',
    description: 'Requires admin scope',
    inputSchema: z.object({}),
    requiredScopes: ['admin'],
    execute: async () => ({ content: 'secret data' }),
});

const testSkill = createSkill({
    name: 'test-skill',
    description: 'A test skill',
    instruction: '# Test Skill\n\nUse this to test things.',
    tools: [echoTool, secretTool],
});

const adminSkill = createSkill({
    name: 'admin-tools',
    description: 'Admin-only skill',
    instruction: '# Admin\n\nAdmin tools.',
    tools: [],
    requiredScopes: ['admin'],
});

const mockWorkspaceOps: WorkspaceProvider = {
    setup: vi.fn().mockResolvedValue(undefined),
    settle: vi.fn().mockResolvedValue({ status: 'settled', commit: 'abc123', summary: '1 file changed' }),
};

// ─── Setup / Teardown ───────────────────────────────────────────────────

beforeEach(async () => {
    masterFs = path.join(TEST_BASE, 'ref');
    sessionPath = path.join(TEST_BASE, 'session');

    ernesto = new Ernesto({
        skills: [testSkill, adminSkill],
        typesense: mockTypesense(),
        masterFsPath: masterFs,
        sessionsPath: TEST_BASE,
    });

    // Materialize master FS
    await ernesto.ensureMasterFS();

    vi.clearAllMocks();
});

afterEach(async () => {
    await fs.rm(TEST_BASE, { recursive: true, force: true }).catch(() => {});
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Session', () => {
    describe('createSession + filesystem structure', () => {
        it('creates session with scoped skills', async () => {
            const session = await ernesto.createSession({ id: 'u1', scopes: ['public'] });

            // test-skill is accessible (no required scopes)
            const skillMd = path.join(session.path, 'skills', 'test-skill', 'SKILL.md');
            const stat = await fs.lstat(skillMd);
            expect(stat.isSymbolicLink()).toBe(true);

            // admin-tools should NOT be present (requires admin scope)
            const adminDir = path.join(session.path, 'skills', 'admin-tools');
            const exists = await fs.stat(adminDir).catch(() => null);
            expect(exists).toBeNull();
        });

        it('includes admin skill when user has admin scope', async () => {
            const session = await ernesto.createSession({ id: 'u1', scopes: ['admin'] });

            const adminMd = path.join(session.path, 'skills', 'admin-tools', 'SKILL.md');
            const stat = await fs.lstat(adminMd);
            expect(stat.isSymbolicLink()).toBe(true);
        });

        it('creates resource directory symlinks', async () => {
            const session = await ernesto.createSession({ id: 'u1', scopes: [] });
            const resDir = path.join(session.path, 'resources');
            const stat = await fs.stat(resDir);
            expect(stat.isDirectory()).toBe(true);
        });

        it('creates workspaces directory', async () => {
            const session = await ernesto.createSession({ id: 'u1', scopes: [] });
            const wsDir = path.join(session.path, 'workspaces');
            const stat = await fs.stat(wsDir);
            expect(stat.isDirectory()).toBe(true);
        });

        it('writes .session marker', async () => {
            const session = await ernesto.createSession({ id: 'u1', scopes: [] });
            const marker = await fs.readFile(path.join(session.path, '.session'), 'utf-8');
            expect(marker.length).toBeGreaterThan(0);
        });
    });

    describe('open()', () => {
        let session: Session;

        beforeEach(async () => {
            session = await ernesto.createSession({ id: 'u1', scopes: [] });
        });

        it('returns overview when no path', async () => {
            const result = await session.open();
            expect(result).toContain('# Ernesto Session');
            expect(result).toContain('test-skill');
            expect(result).toContain('## Usage');
        });

        it('lists directory contents', async () => {
            const result = await session.open('skills/');
            expect(result).toContain('test-skill/');
        });

        it('reads file content', async () => {
            const result = await session.open('skills/test-skill/SKILL.md');
            expect(result).toContain('# Test Skill');
            expect(result).toContain('## Tools');
            expect(result).toContain('echo');
        });

        it('returns "Not found" for missing paths', async () => {
            const result = await session.open('nonexistent/file.txt');
            expect(result).toContain('Not found');
        });

        it('rejects path traversal', async () => {
            await expect(session.open('../../etc/passwd')).rejects.toThrow('outside session');
        });
    });

    describe('progressive disclosure — skills', () => {
        let session: Session;

        beforeEach(async () => {
            session = await ernesto.createSession({ id: 'u1', scopes: [] });
        });

        it('does NOT have references/ before activation', async () => {
            const refsDir = path.join(session.path, 'skills', 'test-skill', 'references');
            const exists = await fs.stat(refsDir).catch(() => null);
            expect(exists).toBeNull();
        });

        it('creates references/ symlink after opening SKILL.md', async () => {
            await session.open('skills/test-skill/SKILL.md');

            const refsDir = path.join(session.path, 'skills', 'test-skill', 'references');
            const stat = await fs.lstat(refsDir);
            expect(stat.isSymbolicLink()).toBe(true);

            // .sh scripts should be accessible through symlink
            const echoSh = path.join(refsDir, 'echo.sh');
            const shStat = await fs.stat(echoSh);
            expect(shStat.isFile()).toBe(true);
        });

        it('activation is idempotent', async () => {
            await session.open('skills/test-skill/SKILL.md');
            await session.open('skills/test-skill/SKILL.md');

            const refsDir = path.join(session.path, 'skills', 'test-skill', 'references');
            const stat = await fs.lstat(refsDir);
            expect(stat.isSymbolicLink()).toBe(true);
        });
    });

    describe('run()', () => {
        let session: Session;

        beforeEach(async () => {
            session = await ernesto.createSession({ id: 'u1', scopes: [] });
        });

        it('fails when skill not activated', async () => {
            const result = await session.run('test-skill', 'echo', { message: 'hello' });
            expect(result.content).toContain('not activated');
        });

        it('fails when skill not found', async () => {
            const result = await session.run('nonexistent', 'echo');
            expect(result.content).toContain('Skill not found');
        });

        it('executes tool after activation', async () => {
            await session.open('skills/test-skill/SKILL.md');
            const result = await session.run('test-skill', 'echo', { message: 'hello world' });
            expect(result.content).toBe('Echo: hello world');
        });

        it('checks scope permissions on tool level', async () => {
            await session.open('skills/test-skill/SKILL.md');
            const result = await session.run('test-skill', 'secret');
            expect(result.content).toContain('Missing scopes');
            expect(result.content).toContain('admin');
        });

        it('returns error for unknown tool name', async () => {
            await session.open('skills/test-skill/SKILL.md');
            const result = await session.run('test-skill', 'nonexistent');
            expect(result.content).toContain('Tool not found');
        });
    });

    describe('settle()', () => {
        it('returns error when no workspace provider', async () => {
            const session = await ernesto.createSession({ id: 'u1', scopes: [] });
            const result = await session.settle('test message');
            expect(result.status).toBe('error');
            expect(result.summary).toContain('No workspace provider');
        });

        it('returns error when no workspace active', async () => {
            const ernestoWithWs = new Ernesto({
                skills: [testSkill],
                typesense: mockTypesense(),
                masterFsPath: path.join(TEST_BASE, 'ref2'),
                sessionsPath: path.join(TEST_BASE, 'sessions2'),
                workspaceOps: {
                    ...mockWorkspaceOps,
                    list: vi.fn().mockResolvedValue([]),
                    checkout: vi.fn(),
                    create: vi.fn(),
                },
            });
            await ernestoWithWs.ensureMasterFS();
            const session = await ernestoWithWs.createSession({ id: 'u1', scopes: [] });
            const result = await session.settle('test');
            expect(result.status).toBe('error');
            expect(result.summary).toContain('No active workspace');
        });
    });

    describe('progressive disclosure — workspaces', () => {
        it('calls workspace provider setup on WORKSPACE.md read', async () => {
            const setupMock = vi.fn().mockResolvedValue(undefined);
            const ernestoWithWs = new Ernesto({
                skills: [testSkill],
                typesense: mockTypesense(),
                masterFsPath: path.join(TEST_BASE, 'ref3'),
                sessionsPath: path.join(TEST_BASE, 'sessions3'),
                workspaceOps: {
                    setup: setupMock,
                    settle: vi.fn().mockResolvedValue({ status: 'ok' }),
                    list: vi.fn().mockResolvedValue(['my-project']),
                    checkout: vi.fn().mockImplementation(async (branch: string, target: string) => {
                        await fs.mkdir(target, { recursive: true });
                        await fs.writeFile(path.join(target, 'WORKSPACE.md'), `# ${branch}\n\nTest workspace.`);
                    }),
                    create: vi.fn(),
                },
            });
            await ernestoWithWs.ensureMasterFS();

            const session = await ernestoWithWs.createSession({ id: 'u1', scopes: [] });

            // Read WORKSPACE.md → triggers workspace activation
            const content = await session.open('workspaces/my-project/WORKSPACE.md');
            expect(content).toContain('# my-project');
            expect(setupMock).toHaveBeenCalledWith(
                'my-project',
                path.join(session.path, 'workspace'),
            );
        });
    });

    describe('e2e: full session lifecycle', () => {
        it('init → activate skill → run tool → verify', async () => {
            // 1. Create session
            const session = await ernesto.createSession({ id: 'u1', scopes: [] });

            // 2. Overview shows skill
            const overview = await session.open();
            expect(overview).toContain('test-skill');

            // 3. Running before activation fails
            const failResult = await session.run('test-skill', 'echo', { message: 'hi' });
            expect(failResult.content).toContain('not activated');

            // 4. Activate by reading SKILL.md
            const skillContent = await session.open('skills/test-skill/SKILL.md');
            expect(skillContent).toContain('# Test Skill');

            // 5. Now run succeeds
            const result = await session.run('test-skill', 'echo', { message: 'hello e2e' });
            expect(result.content).toBe('Echo: hello e2e');

            // 6. Verify filesystem state
            const refsLink = await fs.lstat(path.join(session.path, 'skills', 'test-skill', 'references'));
            expect(refsLink.isSymbolicLink()).toBe(true);
        });
    });

    describe('master FS materialization', () => {
        it('creates SKILL.md with instruction and tool docs', async () => {
            const skillMd = await fs.readFile(
                path.join(masterFs, 'skills', 'test-skill', 'SKILL.md'),
                'utf-8'
            );
            expect(skillMd).toContain('# Test Skill');
            expect(skillMd).toContain('## Tools');
            expect(skillMd).toContain('**echo**');
            expect(skillMd).toContain('**secret**');
        });

        it('creates executable .sh scripts', async () => {
            const shPath = path.join(masterFs, 'skills', 'test-skill', 'references', 'echo.sh');
            const content = await fs.readFile(shPath, 'utf-8');
            expect(content).toContain('#!/usr/bin/env bash');
            expect(content).toContain('curl');
            expect(content).toContain('/ernesto/http/tools/test-skill/echo');

            const stat = await fs.stat(shPath);
            // Check executable bit
            expect(stat.mode & 0o111).toBeGreaterThan(0);
        });

        it('creates resources directory', async () => {
            const stat = await fs.stat(path.join(masterFs, 'resources'));
            expect(stat.isDirectory()).toBe(true);
        });

        it('ensureMasterFS is idempotent', async () => {
            // Already called in beforeEach — call again, should be no-op
            await ernesto.ensureMasterFS();
            const stat = await fs.stat(path.join(masterFs, 'skills', 'test-skill', 'SKILL.md'));
            expect(stat.isFile()).toBe(true);
        });
    });

    describe('writeResourcesToFS', () => {
        it('writes resources as files to master FS', async () => {
            await ernesto.writeResourcesToFS('slack-activity', [
                { name: 'general', path: 'channels/general', content: '# General\n\nMessages...', children: [] },
                { name: 'engineering', path: 'channels/engineering', content: '# Engineering\n\nCode talk.', children: [] },
            ]);

            const general = await fs.readFile(
                path.join(masterFs, 'resources', 'slack-activity', 'channels', 'general.md'),
                'utf-8'
            );
            expect(general).toContain('# General');

            const eng = await fs.readFile(
                path.join(masterFs, 'resources', 'slack-activity', 'channels', 'engineering.md'),
                'utf-8'
            );
            expect(eng).toContain('# Engineering');
        });
    });

    describe('attachToMcpServer', () => {
        it('registers 4 tools on McpServer', async () => {
            const session = await ernesto.createSession({ id: 'u1', scopes: [] });

            const registered: string[] = [];
            const mockServer = {
                registerTool: vi.fn((name: string) => { registered.push(name); }),
            } as any;

            session.attachToMcpServer(mockServer);
            expect(registered).toEqual(['open', 'run', 'write', 'settle']);
        });
    });
});
