/**
 * E2E Integration Test — Full session lifecycle with real filesystem
 *
 * This test exercises the ACTUAL code path an agent would follow:
 * 1. Ernesto materializes master FS (SKILL.md + .sh files)
 * 2. Session is created with scoped symlinks
 * 3. Agent opens overview → sees skills
 * 4. Agent reads SKILL.md → references/ symlink appears
 * 5. Agent runs tool → succeeds
 * 6. Agent reads another skill → that one activates too
 * 7. Resources written to FS → visible via symlinks
 * 8. Multiple sessions are isolated
 *
 * NO MOCKS except Typesense (which is infrastructure, not logic).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { Ernesto } from '../Ernesto';
import { Session } from '../Session';
import { createSkill, createTool } from '../skill';
import { z } from 'zod';

// ─── Test fixtures ──────────────────────────────────────────────────────

const TEST_ROOT = path.join(tmpdir(), 'ernesto-e2e', `run-${Date.now()}`);
const MASTER_FS = path.join(TEST_ROOT, 'ref');
const SESSIONS_DIR = path.join(TEST_ROOT, 'sessions');

function noopTypesense(): any {
    const noop = () => ({ search: async () => ({ hits: [], found: 0 }), import: async () => [], delete: async () => ({ num_deleted: 0 }) });
    return { collections: () => ({ retrieve: async () => ({}), documents: noop }) } as any;
}

const queryTool = createTool({
    name: 'analyst',
    description: 'Run SQL queries',
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) => ({ content: `Results for: ${query}` }),
});

const columnsTool = createTool({
    name: 'get-columns',
    description: 'List table columns',
    inputSchema: z.object({ table: z.string() }),
    execute: async ({ table }) => ({ content: `Columns of ${table}: id, name, created_at` }),
});

const redshiftSkill = createSkill({
    name: 'redshift',
    description: 'Data warehouse queries',
    instruction: '# Redshift Analyst\n\nYou have access to the Bitrefill data warehouse.',
    tools: [queryTool, columnsTool],
});

const scalyrTool = createTool({
    name: 'scalyr-query',
    description: 'Search logs',
    inputSchema: z.object({ filter: z.string() }),
    execute: async ({ filter }) => ({ content: `Log results for: ${filter}` }),
});

const appLogsSkill = createSkill({
    name: 'app-logs',
    description: 'Application log investigation',
    instruction: '# App Logs\n\nUse Scalyr to investigate production logs.',
    tools: [scalyrTool],
    requiredScopes: ['logs'],
});

const marketingSkill = createSkill({
    name: 'marketing',
    description: 'Campaign analytics',
    instruction: '# Marketing\n\nMarketing campaign tools.',
    tools: [],
    requiredScopes: ['marketing'],
});

let ernesto: Ernesto;

// ─── Setup / Teardown ───────────────────────────────────────────────────

beforeAll(async () => {
    ernesto = new Ernesto({
        skills: [redshiftSkill, appLogsSkill, marketingSkill],
        typesense: noopTypesense(),
        masterFsPath: MASTER_FS,
        sessionsPath: SESSIONS_DIR,
    });
    await ernesto.ensureMasterFS();
});

afterAll(async () => {
    await fs.rm(TEST_ROOT, { recursive: true, force: true }).catch(() => {});
});

// ─── Tests ──────────────────────────────────────────────────────────────

describe('E2E: Full session lifecycle', () => {

    describe('Master FS verification', () => {
        it('has SKILL.md for every registered skill', async () => {
            for (const name of ['redshift', 'app-logs', 'marketing']) {
                const md = await fs.readFile(path.join(MASTER_FS, 'skills', name, 'SKILL.md'), 'utf-8');
                expect(md.length).toBeGreaterThan(0);
            }
        });

        it('has .sh scripts for every tool', async () => {
            const redshiftRefs = await fs.readdir(path.join(MASTER_FS, 'skills', 'redshift', 'references'));
            expect(redshiftRefs).toContain('analyst.sh');
            expect(redshiftRefs).toContain('get-columns.sh');

            const logsRefs = await fs.readdir(path.join(MASTER_FS, 'skills', 'app-logs', 'references'));
            expect(logsRefs).toContain('scalyr-query.sh');
        });

        it('.sh scripts contain correct curl endpoint', async () => {
            const sh = await fs.readFile(
                path.join(MASTER_FS, 'skills', 'redshift', 'references', 'analyst.sh'),
                'utf-8',
            );
            expect(sh).toContain('#!/usr/bin/env bash');
            expect(sh).toContain('/ernesto/http/tools/redshift/analyst');
            expect(sh).toContain('curl');
        });

        it('.sh scripts are executable', async () => {
            const stat = await fs.stat(path.join(MASTER_FS, 'skills', 'redshift', 'references', 'analyst.sh'));
            expect(stat.mode & 0o111).toBeGreaterThan(0);
        });
    });

    describe('Session scoping', () => {
        it('public user sees only unrestricted skills', async () => {
            const session = await ernesto.createSession({ id: 'public-user', scopes: [] });
            const overview = await session.open();

            expect(overview).toContain('redshift');
            expect(overview).not.toContain('app-logs');
            expect(overview).not.toContain('marketing');
        });

        it('logs user sees redshift + app-logs but not marketing', async () => {
            const session = await ernesto.createSession({ id: 'logs-user', scopes: ['logs'] });
            const overview = await session.open();

            expect(overview).toContain('redshift');
            expect(overview).toContain('app-logs');
            expect(overview).not.toContain('marketing');
        });

        it('admin user sees everything', async () => {
            const session = await ernesto.createSession({ id: 'admin', scopes: ['logs', 'marketing'] });
            const overview = await session.open();

            expect(overview).toContain('redshift');
            expect(overview).toContain('app-logs');
            expect(overview).toContain('marketing');
        });

        it('filesystem reflects scoping (no symlink for unauthorized skills)', async () => {
            const session = await ernesto.createSession({ id: 'pub', scopes: [] });
            const skillDirs = await fs.readdir(path.join(session.path, 'skills'));
            expect(skillDirs).toContain('redshift');
            expect(skillDirs).not.toContain('app-logs');
        });
    });

    describe('Progressive disclosure flow', () => {
        let session: Session;

        beforeAll(async () => {
            session = await ernesto.createSession({ id: 'dev', scopes: ['logs'] });
        });

        it('step 1: run fails before activation', async () => {
            const result = await session.run('redshift', 'analyst', { query: 'SELECT 1' });
            expect(result.content).toContain('not activated');
        });

        it('step 2: open SKILL.md returns content', async () => {
            const content = await session.open('skills/redshift/SKILL.md');
            expect(content).toContain('# Redshift Analyst');
            expect(content).toContain('## Tools');
            expect(content).toContain('analyst');
            expect(content).toContain('get-columns');
        });

        it('step 3: references/ symlink now exists', async () => {
            const refsPath = path.join(session.path, 'skills', 'redshift', 'references');
            const stat = await fs.lstat(refsPath);
            expect(stat.isSymbolicLink()).toBe(true);

            // Scripts are accessible through the symlink
            const scripts = await fs.readdir(refsPath);
            expect(scripts).toContain('analyst.sh');
            expect(scripts).toContain('get-columns.sh');
        });

        it('step 4: run succeeds after activation', async () => {
            const result = await session.run('redshift', 'analyst', { query: 'SELECT count(*) FROM orders' });
            expect(result.content).toBe('Results for: SELECT count(*) FROM orders');
        });

        it('step 5: second tool works too', async () => {
            const result = await session.run('redshift', 'get-columns', { table: 'orders' });
            expect(result.content).toContain('Columns of orders');
        });

        it('step 6: other skill still not activated', async () => {
            const result = await session.run('app-logs', 'scalyr-query', { filter: 'error' });
            expect(result.content).toContain('not activated');
        });

        it('step 7: activate second skill independently', async () => {
            await session.open('skills/app-logs/SKILL.md');
            const result = await session.run('app-logs', 'scalyr-query', { filter: 'error AND $dataset=accesslog' });
            expect(result.content).toBe('Log results for: error AND $dataset=accesslog');
        });
    });

    describe('Session isolation', () => {
        it('two sessions have independent activation state', async () => {
            const session1 = await ernesto.createSession({ id: 'user1', scopes: [] });
            const session2 = await ernesto.createSession({ id: 'user2', scopes: [] });

            // Activate in session1
            await session1.open('skills/redshift/SKILL.md');
            const s1result = await session1.run('redshift', 'analyst', { query: 'SELECT 1' });
            expect(s1result.content).toContain('Results for');

            // session2 should NOT be activated
            const s2result = await session2.run('redshift', 'analyst', { query: 'SELECT 1' });
            expect(s2result.content).toContain('not activated');
        });

        it('sessions have different filesystem paths', async () => {
            const s1 = await ernesto.createSession({ id: 'u1', scopes: [] });
            const s2 = await ernesto.createSession({ id: 'u2', scopes: [] });
            expect(s1.path).not.toBe(s2.path);
            expect(s1.id).not.toBe(s2.id);
        });
    });

    describe('Resource file materialization', () => {
        it('writes resources to master FS and sessions see them via symlinks', async () => {
            // Write resources
            await ernesto.writeResourcesToFS('slack-activity', [
                { name: 'general', path: 'channels/general', content: '# General\n\nRecent messages...', children: [] },
                { name: 'eng-thread', path: 'threads/eng-1234', content: '# Thread: deploy issue\n\nDetails...', children: [] },
            ]);

            // Verify in master FS
            const general = await fs.readFile(
                path.join(MASTER_FS, 'resources', 'slack-activity', 'channels', 'general.md'),
                'utf-8',
            );
            expect(general).toContain('# General');

            // New session should see them via symlink
            const session = await ernesto.createSession({ id: 'res-user', scopes: [] });
            const resContent = await session.open('resources/');
            expect(resContent).toContain('slack-activity');
        });
    });

    describe('Security', () => {
        it('rejects path traversal via open()', async () => {
            const session = await ernesto.createSession({ id: 'attacker', scopes: [] });
            await expect(session.open('../../etc/passwd')).rejects.toThrow('outside session');
            await expect(session.open('skills/../../etc/passwd')).rejects.toThrow('outside session');
        });

        it('write() only allows workspace/ prefix', async () => {
            const session = await ernesto.createSession({ id: 'u1', scopes: [] });
            const server = {
                registerTool: (_name: string, _opts: any, handler: any) => {
                    if (_name === 'write') {
                        (session as any)._writeHandler = handler;
                    }
                },
            } as any;
            session.attachToMcpServer(server);

            // Try writing outside workspace/
            const badResult = await (session as any)._writeHandler({ path: 'skills/evil.md', content: 'hacked' });
            expect(badResult.content[0].text).toContain('restricted to workspace/');
        });
    });
});
