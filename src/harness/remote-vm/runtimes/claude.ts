/**
 * claude (cas) runtime for the VM placement — FULL ernesto surface.
 *
 * Runs the Claude Agent SDK `query()` loop in the VM (what cas runs locally),
 * with the FULL tool surface:
 *   - native FS tools over the FUSE workdir (Read/Glob/Grep/Write/Edit/Bash);
 *   - an in-VM `ernesto` MCP: `execute` posts to the host's route-dispatch
 *     endpoint (route dispatch as the scoped principal), `settle` posts to the
 *     in-VM control server that ships the FUSE overlay;
 *   - an in-VM `ui` MCP: `ui` writes the component as a `__ernesto_ui__`
 *     marker line on stdout, which `mapLine` lifts into a `component`
 *     HarnessEvent → the host emits `fact.component` → the per-transport
 *     renderers. This is the bridge that makes in-VM `ui` calls render.
 *
 * SDKMessages stream as NDJSON and map via the SAME `cas/events` translator.
 */

import type { AgentDefinition, SystemPromptConfig } from '../../types';
import type { VmRuntime } from '../runtime';
import { createTranslatorState, mapVmLine } from '../events';

export const CLAUDE_VM_DRIVER_PATH = '/opt/vm/claude-driver.mjs';

/** Marker line the in-VM `ui` tool prints; lifted to a `component` event. */
const UI_MARKER = '__ernesto_ui__';

export const CLAUDE_VM_DRIVER_SOURCE = `import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const prompt = process.argv[2] || process.env.AGENT_PROMPT || '';
// argv[3] is a JSON config blob: { model?, systemPrompt, disallowedTools? }.
// Carries the resolved agent definition (incl. dispatch-time tool-surface
// extras: workspace-claim denials + systemPrompt hints) into the VM.
let cfg = {};
try { cfg = JSON.parse(process.argv[3] || '{}'); } catch { cfg = {}; }
const model = cfg.model || process.env.AGENT_MODEL || undefined;
const BACKEND = process.env.ERNESTO_VM_BACKEND_URL || '';
const CONTROL = 'http://127.0.0.1:7070';
const HDRS = { 'content-type': 'application/json', 'ngrok-skip-browser-warning': '1' };
const w = (o) => process.stdout.write(JSON.stringify(o) + '\\n');

async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: HDRS, body: JSON.stringify(body) });
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { ok: false, error: 'non_json', status: r.status, body: t.slice(0, 300) }; }
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

const ernesto = createSdkMcpServer({ name: 'ernesto', version: '1.0.0', tools: [
  tool('execute', 'Dispatch an ernesto route by URI (e.g. _platform://task, a dashboard, a typed route).', { uri: z.string(), params: z.any().optional() },
    async ({ uri, params }) => {
      // Coerce stringified params (haiku often JSON-encodes the object) into
      // a real object so the route's Zod input validation sees the right shape.
      let p = params;
      if (typeof p === 'string') { try { p = JSON.parse(p); } catch { /* leave as-is */ } }
      const d = await post(BACKEND + '/ernesto/vm/execute', { uri, params: p || {} });
      return { content: [{ type: 'text', text: JSON.stringify(d) }] };
    }),
  tool('settle', 'Commit your workspace edits (ships the FUSE write-overlay through lint + bot push).', { workspaces: z.array(z.string()), message: z.string() },
    async ({ workspaces, message }) => { const d = await post(CONTROL + '/settle', { workspaces, message }); return { content: [{ type: 'text', text: JSON.stringify(d) }] }; }),
] });

const ui = createSdkMcpServer({ name: 'ui', version: '1.0.0', tools: [
  tool('ui', 'Render UI components to the user (markdown/table/hitl/etc). Pass the component array.', { component: z.any() },
    async ({ component }) => { w({ ${JSON.stringify(UI_MARKER)}: true, component }); return { content: [{ type: 'text', text: 'rendered' }] }; }),
] });

const options = {
  cwd: process.cwd(),
  permissionMode: 'bypassPermissions',
  allowedTools: ['Read','Glob','Grep','Write','Edit','Bash','mcp__ernesto__execute','mcp__ernesto__settle','mcp__ui__ui'],
  // Denylist on top of the allowlist — authority-scoped workspace claims
  // (replacesBuiltinTools) + the author's declared disallowedTools.
  ...(Array.isArray(cfg.disallowedTools) && cfg.disallowedTools.length ? { disallowedTools: cfg.disallowedTools } : {}),
  mcpServers: { ernesto, ui },
  maxTurns: Number(process.env.AGENT_MAX_TURNS || 24),
  ...(model ? { model } : {}),
  // The resolved agent systemPrompt (string or { type:'preset', append }).
  // Carries the systemPromptExtras the composer appended at dispatch time.
  ...(cfg.systemPrompt !== undefined ? { systemPrompt: cfg.systemPrompt } : {}),
};
try { for await (const msg of query({ prompt, options })) w(msg); }
catch (err) { w({ type: 'result', subtype: 'error_during_execution', is_error: true, result: String(err && err.message || err) }); process.exit(1); }
`;

export function buildClaudeArgv(def: AgentDefinition, prompt: string): string[] {
    const model = typeof def.model === 'string' ? def.model : def.model.id;
    // Single JSON config arg — robust to optional fields (a bare positional
    // `model` mis-aligns when absent). Forwards systemPrompt + disallowedTools
    // so the in-VM driver honours them (parity with the cas harness); without
    // this the VM silently drops both, defeating workspace-claim enforcement.
    const config: {
        model?: string;
        systemPrompt: SystemPromptConfig;
        disallowedTools?: string[];
    } = { systemPrompt: def.systemPrompt };
    if (model) config.model = model;
    if (def.disallowedTools && def.disallowedTools.length > 0) {
        config.disallowedTools = def.disallowedTools;
    }
    return ['node', CLAUDE_VM_DRIVER_PATH, prompt, JSON.stringify(config)];
}

export const claudeVmRuntime: VmRuntime = {
    name: 'claude',
    buildArgv: buildClaudeArgv,
    createState: () => createTranslatorState(),
    mapLine: (line, runId, state) => {
        const t = line.trim();
        if (t.startsWith('{') && t.includes(UI_MARKER)) {
            try {
                const o = JSON.parse(t) as { [k: string]: unknown };
                if (o && o[UI_MARKER]) return [{ kind: 'component', component: o.component, runId }];
            } catch { /* fall through to SDK mapping */ }
        }
        return mapVmLine(line, runId, state as ReturnType<typeof createTranslatorState>);
    },
};
