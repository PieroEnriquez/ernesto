import { readFileSync } from 'fs';
import { join } from 'path';
import type {
    AgentDeclaration,
    AgentContext,
    CompiledAgent,
    SystemPromptConfig,
} from './types';

/**
 * Pure composer (§7.1). Turns an `AgentDeclaration` + threading
 * `AgentContext` into a transport-agnostic `CompiledAgent`. The only
 * I/O is reading `workspaces/_platform/WORKSPACE.md` from the bound
 * workdir cwd to append the platform's editorial guardrails (§3.5 /
 * §13) — sub-ms, fails silently if absent.
 *
 * Stop 2 of §7 phase 1. Subsequent stops layer in:
 * - §7.3 L1-L5 cache discipline (returns layered fragments instead of
 *   a flat `systemPrompt`; backend keeps the layers cacheable).
 * - §7.5 template resolver (`{{ns.name}}` placeholders).
 * - §7.6 schema refs (`route:` / `schema:` inlining).
 * - §7.12 subagent context (`subagentDepth`, `parent.scope ∩
 *   decl.scope`).
 *
 * Today the job is just to be the single home for this composition so
 * Tier A / B / C don't each reimplement it.
 */
export function compileAgent(
    decl: AgentDeclaration,
    ctx: AgentContext,
    defaults: { disallowedTools?: string[] } = {},
): CompiledAgent {
    const platformBody = readPlatformBody(ctx.session.cwd);
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
 * Read `<cwd>/workspaces/_platform/WORKSPACE.md` body, frontmatter
 * stripped. Sync on purpose — ~4 KB, one read per session boot,
 * sub-ms. Async would ripple through every Tier-frontend caller
 * for no measurable win.
 *
 * Deliberately does NOT walk parent directories — the path is fixed
 * under the bound workdir, not discovered. Personal CLAUDE.md files
 * above the workdir root can never bleed into agent prompts.
 */
function readPlatformBody(cwd: string | undefined): string | null {
    if (!cwd) return null;
    const p = join(cwd, 'workspaces', '_platform', 'WORKSPACE.md');
    let raw: string;
    try {
        raw = readFileSync(p, 'utf8');
    } catch {
        return null;
    }
    if (!raw.startsWith('---')) {
        return raw.trim().length > 0 ? raw : null;
    }
    const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
    const body = m ? raw.slice(m[0].length) : raw;
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
