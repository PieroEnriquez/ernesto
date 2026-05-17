import { readFileSync } from 'fs';
import { join } from 'path';
import type {
    AgentDeclaration,
    AgentContext,
    CompiledAgent,
    SystemPromptConfig,
    TierId,
} from './types';

/**
 * Pure composer (§7.1). Turns an `AgentDeclaration` + threading
 * `AgentContext` into a transport-agnostic `CompiledAgent`. The only
 * I/O is reading the platform body from the bound workdir cwd to
 * append the editorial guardrails (§3.5 / §13) — sub-ms, fails
 * silently if absent.
 *
 * Platform body composition (§7.3 stop):
 *   `<cwd>/workspaces/_platform/WORKSPACE.md`         (universal)
 *   `<cwd>/workspaces/_platform/tier-{a|b|c}.md`      (tier-specific,
 *                                                      appended when
 *                                                      `ctx.tier` set)
 *
 * Tier-specific files describe how the Ernesto system itself behaves
 * on that tier (workdir mechanics, settle pathway, what `execute`
 * looks like). The per-tier file is loaded *in addition to* the
 * universal body — never instead of it. Tier frontends pass
 * `ctx.tier = 'A' | 'B' | 'C'`. Frontends that haven't been migrated
 * (or scripts / tests without a workdir) keep working unchanged.
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
    const platformBody = composePlatformBody(ctx.session.cwd, ctx.tier);
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
 * Compose the universal platform body + (optionally) the tier-specific
 * body from a bound workdir cwd. Returns the concatenated markdown or
 * `null` if neither file resolves to non-empty content.
 *
 * This is the single home for the composition across all three tier
 * frontends:
 *
 * - **Tier A** (backend): `compileAgent` calls this; result becomes
 *   the SDK `Options.systemPrompt` append.
 * - **Tier B** (claude.ai MCP): the MCP server calls this directly;
 *   result becomes the `instructions:` field.
 * - **Tier C** (laptop CLI / Claude Code skill): the CLI calls this
 *   when regenerating `~/.claude/skills/ernesto/SKILL.md`.
 *
 * All three reach for the same files, so behavioral drift between
 * tiers can only come from authoring drift in the markdown — not from
 * the loaders interpreting things differently.
 *
 * Frontmatter is stripped from each file. Empty/absent files are
 * skipped silently (callers don't need to branch).
 */
export function composePlatformBody(
    cwd: string | undefined,
    tier?: TierId,
): string | null {
    const universal = readPlatformBody(cwd);
    const tierBody = tier ? readTierBody(cwd, tier) : null;
    if (universal && tierBody) return universal + '\n\n' + tierBody;
    return universal ?? tierBody ?? null;
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
    return readMarkdownBody(join(cwd, 'workspaces', '_platform', 'WORKSPACE.md'));
}

/**
 * Read `<cwd>/workspaces/_platform/tier-{a|b|c}.md` body, frontmatter
 * stripped. Optional — absent files are not an error (a tier that
 * hasn't authored its file yet inherits only the universal body).
 */
function readTierBody(cwd: string | undefined, tier: TierId): string | null {
    if (!cwd) return null;
    const slug = tier.toLowerCase();
    return readMarkdownBody(join(cwd, 'workspaces', '_platform', `tier-${slug}.md`));
}

function readMarkdownBody(path: string): string | null {
    let raw: string;
    try {
        raw = readFileSync(path, 'utf8');
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
