import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createUiMcpServer, UI_TOOL_COUNT, UI_TOOL_NAMES } from '../server';
import { HitlController } from '../../workflow-engine/hitl';
import type { UiHitlPauser } from '../types';
import { EventBus } from '../../workflow-engine/event-bus';
import { InMemoryStore } from '../../workflow-engine/store/in-memory-store';
import type { UiToolContext } from '../types';
import type { UiMcpServerHandle } from '../server';

let active: UiMcpServerHandle | undefined;
afterEach(async () => {
    if (active) {
        await active.close();
        active = undefined;
    }
});

describe('createUiMcpServer', () => {
    it('exposes exactly one unified `ui` tool', () => {
        expect(UI_TOOL_COUNT).toBe(1);
        expect(UI_TOOL_NAMES).toEqual(['ui']);
    });

    it('binds to 127.0.0.1 on an ephemeral port and is reachable', async () => {
        const emitted: any[] = [];
        const ctx: UiToolContext = {
            runId: 'r-1',
            stepId: 's-1',
            emit: (e) => emitted.push(e),
            hitl: {} as UiHitlPauser,
        };
        active = await createUiMcpServer({ context: ctx });

        expect(active.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(active.name).toBe('ui');
        expect(active.config.type).toBe('http');
    });

    it('routes a single-component `ui` call and emits fact.component', async () => {
        const emitted: any[] = [];
        const ctx: UiToolContext = {
            runId: 'r-1',
            stepId: 's-1',
            emit: (e) => emitted.push(e),
            hitl: {} as UiHitlPauser,
        };
        active = await createUiMcpServer({ context: ctx });

        const client = new Client({ name: 'test', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(active.url));
        await client.connect(transport);

        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(1);
        expect(tools.tools[0]?.name).toBe('ui');

        await client.callTool({
            name: 'ui',
            arguments: {
                component: {
                    kind: 'status',
                    props: { text: 'fetching', level: 'progress' },
                },
            },
        });

        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
            type: 'fact.component',
            component: {
                kind: 'status',
                props: { text: 'fetching', level: 'progress' },
            },
        });

        await client.close();
    });

    it('routes an array-of-components `ui` call and emits each', async () => {
        const emitted: any[] = [];
        const ctx: UiToolContext = {
            runId: 'r-1',
            stepId: 's-1',
            emit: (e) => emitted.push(e),
            hitl: {} as UiHitlPauser,
        };
        active = await createUiMcpServer({ context: ctx });

        const client = new Client({ name: 'test', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(active.url));
        await client.connect(transport);

        await client.callTool({
            name: 'ui',
            arguments: {
                component: [
                    { kind: 'status', props: { text: 'a' } },
                    { kind: 'thinking', props: { text: 'b' } },
                ],
            },
        });

        expect(emitted).toHaveLength(2);
        expect(emitted[0].component.kind).toBe('status');
        expect(emitted[1].component.kind).toBe('thinking');

        await client.close();
    });

    it('routes a hitl/expect=choice `ui` call through the HITL controller', async () => {
        const bus = new EventBus();
        const store = new InMemoryStore();
        let seq = 0;
        const hitl = new HitlController(bus, store, () => seq++);
        await store.putRunState({
            runId: 'r-1',
            workflow: 'wf',
            status: 'running',
            inputs: {},
            routing: {},
            startedAt: Date.now(),
        });
        const ctx: UiToolContext = {
            runId: 'r-1',
            stepId: 's-1',
            emit: () => undefined,
            hitl,
        };

        // Subscribe BEFORE the tool call lands so the pause event is
        // captured live.
        const busEvents: any[] = [];
        const sub = await bus.subscribe({
            onEvent: (e) => busEvents.push(e),
        });

        active = await createUiMcpServer({ context: ctx });

        const client = new Client({ name: 'test', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(active.url));
        await client.connect(transport);

        const callPromise = client.callTool({
            name: 'ui',
            arguments: {
                component: {
                    kind: 'hitl',
                    props: {
                        render: [{ kind: 'markdown', props: { body: 'Pick' } }],
                        expect: {
                            kind: 'choice',
                            schema: { enum: ['a', 'b'] },
                        },
                        resumePrompt: 'picked {value}',
                    },
                },
            },
        });

        for (let i = 0; i < 50; i++) {
            if (busEvents.some((e) => e.type === 'fact.run_paused_human')) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        const paused = busEvents.find((e) => e.type === 'fact.run_paused_human');
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await hitl.resume('r-1', { promptId, value: 'b' });

        const result = await callPromise;
        const text = (result.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text;
        expect(text).toBe('b');

        await client.close();
        await sub.close();
    });

    it('rejects unknown kinds via the validator (no emit)', async () => {
        const emitted: any[] = [];
        const ctx: UiToolContext = {
            runId: 'r',
            stepId: 's',
            emit: (e) => emitted.push(e),
            hitl: {} as UiHitlPauser,
        };
        active = await createUiMcpServer({ context: ctx });

        const client = new Client({ name: 'test', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(active.url));
        await client.connect(transport);

        // The Zod schema rejects unknown kind enum members at the wire;
        // older clients may still try and we get a structured error.
        const result = await client
            .callTool({
                name: 'ui',
                arguments: {
                    component: { kind: 'bogus', props: {} },
                },
            })
            .catch((err: Error) => ({ isError: true, error: err.message }));

        expect(emitted).toHaveLength(0);
        expect(result).toBeDefined();

        await client.close();
    });
});
