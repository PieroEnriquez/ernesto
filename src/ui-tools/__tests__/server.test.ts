import { describe, it, expect, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
    createUiMcpServer,
    UI_TOOL_COUNT,
    UI_TOOL_NAMES,
} from '../server';
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
    it('exposes exactly 15 ui.* tools', () => {
        expect(UI_TOOL_COUNT).toBe(15);
        expect(UI_TOOL_NAMES).toEqual([
            'ui.status',
            'ui.table',
            'ui.metric',
            'ui.markdown',
            'ui.image',
            'ui.code',
            'ui.link',
            'ui.attachment',
            'ui.progress',
            'ui.choice_input',
            'ui.text_input',
            'ui.form',
            'ui.chart',
            'ui.tree',
            'ui.thinking',
        ]);
    });

    it('binds to 127.0.0.1 on an ephemeral port and is reachable', async () => {
        const emitted: any[] = [];
        const ctx: UiToolContext = {
            runId: 'r-1',
            stepId: 's-1',
            emit: (e) => emitted.push(e),
            // HitlController not used by non-input tools — pass a
            // structural stub so the type checks.
            hitl: {} as UiHitlPauser,
        };
        active = await createUiMcpServer({ context: ctx });

        expect(active.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
        expect(active.name).toBe('ui');
        expect(active.config.type).toBe('http');
    });

    it('routes a tool call to the right handler and emits fact.component', async () => {
        const emitted: any[] = [];
        const ctx: UiToolContext = {
            runId: 'r-1',
            stepId: 's-1',
            emit: (e) => emitted.push(e),
            hitl: {} as UiHitlPauser,
        };
        active = await createUiMcpServer({ context: ctx });

        const client = new Client({ name: 'test', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(
            new URL(active.url),
        );
        await client.connect(transport);

        const tools = await client.listTools();
        expect(tools.tools.length).toBe(UI_TOOL_COUNT);
        const names = tools.tools.map((t) => t.name).sort();
        expect(names).toEqual([...UI_TOOL_NAMES].sort());

        await client.callTool({
            name: 'ui.markdown',
            arguments: { body: '## hi' },
        });

        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
            type: 'fact.component',
            component: {
                kind: 'markdown',
                props: { body: '## hi' },
            },
        });

        await client.close();
    });

    it('routes a choice_input tool call through the HITL controller', async () => {
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
        // captured live. HitlController publishes to the bus but
        // doesn't persist to the store, so a fresh subscriber after
        // the fact would miss it.
        const busEvents: any[] = [];
        const sub = await bus.subscribe({
            onEvent: (e) => busEvents.push(e),
        });

        active = await createUiMcpServer({ context: ctx });

        const client = new Client({ name: 'test', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(
            new URL(active.url),
        );
        await client.connect(transport);

        const callPromise = client.callTool({
            name: 'ui.choice_input',
            arguments: {
                prompt: 'Pick',
                choices: [
                    { value: 'a', label: 'A' },
                    { value: 'b', label: 'B' },
                ],
            },
        });

        // Poll until the pause event is observed.
        for (let i = 0; i < 50; i++) {
            if (busEvents.some((e) => e.type === 'fact.run_paused_human')) break;
            await new Promise((r) => setTimeout(r, 10));
        }
        const paused = busEvents.find(
            (e) => e.type === 'fact.run_paused_human',
        );
        expect(paused).toBeDefined();
        const promptId = (paused!.payload as { promptId: string }).promptId;
        await hitl.resume('r-1', {
            promptId,
            value: { choice: 'b' },
        });

        const result = await callPromise;
        // The MCP server returns the handler output as a `text`
        // content block; the handler returned the string 'b' directly,
        // so the wrapped content text equals 'b'.
        const text = (result.content as Array<{ type: string; text?: string }>)
            .find((c) => c.type === 'text')?.text;
        expect(text).toBe('b');

        await client.close();
        await sub.close();
    });
});
