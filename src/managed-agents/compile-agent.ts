/**
 * Build the runtime `CompiledAgent` transport for a managed agent at
 * dispatch time. NOT the same as `workflows/compile-managed-agent.ts`,
 * which projects a registration-time `WorkflowDeclaration` from the
 * same Markdown.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { readFrontmatter } from '../frontmatter';
import type {
    AgentDeclaration,
    AgentContext,
    CompiledAgent,
    SystemPromptConfig,
    Transport,
} from './types';

/**
 * Pure composer (§7.1). Turns an `AgentDeclaration` + threading
 * `AgentContext` into a transport-agnostic `CompiledAgent`. The only
 * I/O is reading the platform body from the bound workdir cwd to
 * append the editorial guardrails (§3.5 / §13) — sub-ms, fails
 * silently if absent.
 *
 * Platform body composition (§7.3 stop):
 *   `<cwd>/workspaces/_platform/WORKSPACE.md`         (universal engine contract)
 *   `<cwd>/workspaces/_platform/<transport>.md`       (per-transport overlay —
 *                                                      in-process / mcp —
 *                                                      appended when set)
 *
 * The per-transport files describe how the Ernesto system itself behaves
 * on that transport (workdir mechanics, settle pathway, what `execute`
 * looks like). The per-transport file is loaded *in addition to* the
 * universal body — never instead of it. Frontends pass the transport
 * (`ctx.transport = 'in-process' | 'mcp' | 'laptop' | 'vm'`). Frontends
 * that haven't been migrated (or scripts / tests without a workdir) keep
 * working unchanged.
 *
 * Stop 2 of §7 phase 1. Subsequent stops layer in:
 * - §7.3 L1-L5 cache discipline (returns layered fragments instead of
 *   a flat `systemPrompt`; backend keeps the layers cacheable).
 * - §7.5 template resolver (`{{ns.name}}` placeholders).
 * - §7.6 schema refs (`route:` / `schema:` inlining).
 * - §7.12 subagent context (`subagentDepth`, `parent.scope ∩
 *   decl.scope`).
 */
export function compileAgent(
    decl: AgentDeclaration,
    ctx: AgentContext,
    defaults: { disallowedTools?: string[] } = {},
): CompiledAgent {
    const platformBody = composePlatformBody(ctx.cwd, ctx.transport);
    const systemPrompt = platformBody
        ? appendPlatformBody(decl.systemPrompt, platformBody)
        : decl.systemPrompt;

    return {
        model: decl.model,
        systemPrompt,
        maxTurns: decl.maxTurns,
        mcpServers: decl.mcpServers,
        outputFormat: decl.outputFormat,
        disallowedTools: decl.disallowedTools ?? defaults.disallowedTools,
    };
}

/**
 * Compose the universal platform body + (optionally) the per-transport
 * body from a bound workdir cwd. Returns the concatenated markdown or
 * `null` if neither file resolves to non-empty content.
 *
 * This is the single home for the composition across all transports:
 *
 * - **the in-process transport** (runs in the host process):
 *   `compileAgent` calls this; result becomes the SDK
 *   `Options.systemPrompt` append.
 * - **the mcp transport** (a remote MCP client): the MCP server calls
 *   this directly; result becomes the `instructions:` field.
 * - **the laptop transport** (a dev laptop with a synced checkout +
 *   plugin): the laptop calls this when regenerating its local skill.
 *
 * They all reach for the same files, so behavioral drift between
 * transports can only come from authoring drift in the markdown — not
 * from the loaders interpreting things differently.
 *
 * Frontmatter is stripped from each file. Empty/absent files are
 * skipped silently (callers don't need to branch).
 */
export function composePlatformBody(
    cwd: string | undefined,
    transport?: Transport,
): string | null {
    const universal = readPlatformBody(cwd);
    const overlayBody = transport ? readTransportOverlay(cwd, transport) : null;
    if (universal && overlayBody) return universal + '\n\n' + overlayBody;
    return universal ?? overlayBody ?? null;
}

/**
 * Read `<cwd>/workspaces/_platform/WORKSPACE.md` body, frontmatter
 * stripped. Sync on purpose — ~4 KB, one read per agent boot,
 * sub-ms. Async would ripple through every frontend caller
 * for no measurable win.
 *
 * Deliberately does NOT walk parent directories — the path is fixed
 * under the bound workdir, not discovered. Personal CLAUDE.md files
 * above the workdir root can never bleed into agent prompts.
 */
function readPlatformBody(cwd: string | undefined): string | null {
    if (!cwd) return null;
    return readMarkdownBody(join(cwd, 'workspaces', '_platform', 'WORKSPACE.md'));
}

/**
 * Read the per-transport overlay body (`_platform/<overlay>.md`),
 * frontmatter stripped, for backend-run agents. Optional — absent files
 * are not an error.
 *
 * Only the backend-injected transports map to an overlay file:
 * `in-process` (and `vm`, which shares the in-process substrate — VM is
 * isolation, not a separate overlay) → `in-process.md`; `mcp` →
 * `mcp.md`. A `laptop` run carries its own overlay (the plugin's
 * SKILL.md) and is not injected from `_platform`, so it resolves to null.
 */
const OVERLAY_BY_TRANSPORT: Record<string, string> = {
    'in-process': 'in-process',
    'vm': 'in-process',
    'mcp': 'mcp',
};
function readTransportOverlay(cwd: string | undefined, transport: Transport): string | null {
    if (!cwd) return null;
    const overlay = OVERLAY_BY_TRANSPORT[transport];
    if (!overlay) return null;
    return readMarkdownBody(join(cwd, 'workspaces', '_platform', `${overlay}.md`));
}

function readMarkdownBody(path: string): string | null {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
    } catch {
        return null;
    }
    // Frontmatter here is optional: a fence-less platform body is the
    // whole file. `readFrontmatter` returns the raw input as `body`
    // when there's no (terminated) fence, so this stays a no-op for
    // fence-less files while sharing the split logic with the spec
    // readers.
    const { body } = readFrontmatter(raw);
    return body.trim().length > 0 ? body : null;
}

function appendPlatformBody(
    base: SystemPromptConfig,
    platformBody: string,
): SystemPromptConfig {
    if (typeof base === 'string') {
        return base + '\n\n' + platformBody;
    }
    return {
        type: 'preset',
        preset: base.preset,
        append: (base.append ? base.append + '\n\n' : '') + platformBody,
    };
}
