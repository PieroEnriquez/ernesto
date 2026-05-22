/**
 * MCP synthesis layer roundtrip — fn tool → in-process HTTP MCP
 * server → MCP client lists + invokes.
 *
 * The test starts the synth server, connects an MCP client over HTTP
 * to the loopback URL, asserts the tool appears in the discovery list,
 * invokes it, and verifies the handler ran in-process and returned
 * the expected payload.
 *
 * This is the load-bearing test for step 2: if this passes, the
 * step-3 fragua adapter can rely on the same bridge to expose MCP
 * servers as fn-shaped tools to fragua's ToolRegistry.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolSpec } from '../../types';
import {
    wrapFnAsMcpServer,
    wrapFnToolsAsMcpServers,
    type SynthMcpServerHandle,
} from '../mcp-bridge';

const openHandles: SynthMcpServerHandle[] = [];

afterEach(async () => {
    await Promise.all(openHandles.splice(0).map((h) => h.close()));
});

function trackHandle(handle: SynthMcpServerHandle): SynthMcpServerHandle {
    openHandles.push(handle);
    return handle;
}

async function makeClient(url: string): Promise<Client> {
    const client = new Client(
        { name: 'test-client', version: '0.0.0' },
        { capabilities: {} },
    );
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    return client;
}

describe('wrapFnAsMcpServer', () => {
    it('exposes the fn tool via MCP tools/list and tools/call', async () => {
        let invokedWith: unknown = undefined;
        const toolSpec: ToolSpec & { kind: 'fn' } = {
            kind: 'fn',
            name: 'echo',
            description: 'Echo back its input',
            schema: {
                type: 'object',
                properties: { message: { type: 'string' } },
            },
            handler: async (input) => {
                invokedWith = input;
                return { ok: true, received: input };
            },
        };

        const handle = trackHandle(await wrapFnAsMcpServer(toolSpec));
        expect(handle.config.type).toBe('http');
        expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

        const client = await makeClient(handle.url);
        try {
            const list = await client.listTools();
            const names = list.tools.map((t) => t.name);
            expect(names).toContain('echo');
            const tool = list.tools.find((t) => t.name === 'echo')!;
            expect(tool.description).toBe('Echo back its input');

            const result = await client.callTool({
                name: 'echo',
                arguments: { message: 'hi' },
            });
            expect(invokedWith).toEqual({ message: 'hi' });
            expect(result.isError).toBeFalsy();
            // Result content is `[{ type: 'text', text: JSON.stringify(out) }]`.
            const content = result.content as Array<{ type: string; text: string }>;
            expect(content[0]?.type).toBe('text');
            const parsed = JSON.parse(content[0]!.text);
            expect(parsed).toEqual({ ok: true, received: { message: 'hi' } });
        } finally {
            await client.close();
        }
    });

    it('is idempotent: same toolSpec → same handle (no double spawn)', async () => {
        const toolSpec: ToolSpec & { kind: 'fn' } = {
            kind: 'fn',
            name: 'noop',
            description: '',
            schema: {},
            handler: async () => 'ok',
        };
        const h1 = await wrapFnAsMcpServer(toolSpec);
        const h2 = await wrapFnAsMcpServer(toolSpec);
        expect(h1).toBe(h2);
        trackHandle(h1);
    });

    it('handler errors surface as MCP tool error result', async () => {
        const toolSpec: ToolSpec & { kind: 'fn' } = {
            kind: 'fn',
            name: 'boom',
            description: '',
            schema: {},
            handler: async () => {
                throw new Error('boom');
            },
        };
        const handle = trackHandle(await wrapFnAsMcpServer(toolSpec));
        const client = await makeClient(handle.url);
        try {
            const result = await client.callTool({ name: 'boom', arguments: {} });
            expect(result.isError).toBe(true);
            const content = result.content as Array<{ type: string; text: string }>;
            expect(content[0]?.text).toBe('boom');
        } finally {
            await client.close();
        }
    });
});

describe('wrapFnToolsAsMcpServers', () => {
    it('passes through non-fn tools and synthesizes only the fn ones', async () => {
        const fnTool: ToolSpec = {
            kind: 'fn',
            name: 'adder',
            description: 'adds',
            schema: {},
            handler: async () => 0,
        };
        const builtinTool: ToolSpec = { kind: 'builtin', name: 'Read' };
        const mcpTool: ToolSpec = { kind: 'mcp', serverName: 'remote' };

        const wrapped = await wrapFnToolsAsMcpServers([
            fnTool,
            builtinTool,
            mcpTool,
        ]);
        try {
            expect(Object.keys(wrapped.mcpServers)).toHaveLength(1);
            expect(Object.keys(wrapped.mcpServers)[0]).toMatch(/^synth_/);
            expect(wrapped.passThrough).toEqual([builtinTool, mcpTool]);
            expect(wrapped.handles).toHaveLength(1);
        } finally {
            await wrapped.closeAll();
        }
    });

    it('closeAll() shuts down every synth server', async () => {
        const tools: ToolSpec[] = [
            {
                kind: 'fn',
                name: 'a',
                description: '',
                schema: {},
                handler: async () => 0,
            },
            {
                kind: 'fn',
                name: 'b',
                description: '',
                schema: {},
                handler: async () => 0,
            },
        ];
        const wrapped = await wrapFnToolsAsMcpServers(tools);
        expect(wrapped.handles).toHaveLength(2);
        await wrapped.closeAll();
        // After closing, calling close() again is a no-op.
        await wrapped.closeAll();
    });
});
