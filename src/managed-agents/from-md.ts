import { load as yamlLoad } from 'js-yaml';
import type {
    AgentDeclaration,
    SystemPromptConfig,
    JsonSchemaOutputFormat,
} from './types';

/**
 * Raw parsed shape of a `workspaces/<w>/managed-agents/<slug>.md` file.
 *
 * Keeping `frontMatter` as a raw `Record<string, unknown>` (instead of
 * projecting straight to `AgentDeclaration`) preserves the reserved
 * fields stops 7+ will read — `trigger`, `requires`, `callableAs`,
 * `consumes` — without round-tripping through a narrower type today.
 */
export interface ManagedAgentMd {
    slug: string;
    workspace: string;
    frontMatter: Record<string, unknown>;
    /** Body text below the closing `---`, trimmed. */
    body: string;
}

/**
 * Strict allowlist of frontmatter keys. Anything else throws at parse
 * time — catches typos (`scopes:` vs `scope:`, `mcpServer:` vs
 * `mcpServers:`) that would otherwise silently parse to the wrong
 * semantics. Reserved keys are kept on `ManagedAgentMd.frontMatter`
 * for stops 7+ but rejected nowhere else.
 */
const PROJECTED_FRONTMATTER_KEYS = new Set([
    'slug', 'name', 'description', 'provider', 'model',
    'systemPrompt', 'maxTurns', 'mcpServers', 'outputFormat',
    'disallowedTools', 'scope', 'callableAs',
]);
const RESERVED_FRONTMATTER_KEYS = new Set([
    'trigger', 'requires', 'consumes',
]);

/**
 * Parse a managed-agent markdown file.
 *
 * The file must begin with a `---\n…\n---\n` YAML frontmatter block;
 * the rest is the agent body. Body composes into the system prompt
 * per §7 (see `toAgentDeclaration`).
 */
export function parseManagedAgentMd(
    raw: string,
    opts: { slug: string; workspace: string },
): ManagedAgentMd {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!match) {
        throw new Error(
            `managed-agents/${opts.slug}.md: missing YAML frontmatter (file must begin with "---")`,
        );
    }
    const fm = yamlLoad(match[1]);
    if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
        throw new Error(
            `managed-agents/${opts.slug}.md: frontmatter must be a YAML object`,
        );
    }
    return {
        slug: opts.slug,
        workspace: opts.workspace,
        frontMatter: fm as Record<string, unknown>,
        body: match[2].trim(),
    };
}

/**
 * Project a parsed `ManagedAgentMd` into an `AgentDeclaration` ready
 * for `compileAgent`. §7 frontmatter table — see
 * `domains/workspaces/README.md`.
 *
 * System-prompt composition (§7 table at line 1095):
 *
 * | Frontmatter `systemPrompt`                  | Output                                  |
 * |---------------------------------------------|-----------------------------------------|
 * | absent                                      | body becomes the system prompt (string) |
 * | `{type: preset, preset: claude_code}`       | preset with `append = body`             |
 * | `{type: preset, ..., append: "<extra>"}`    | preset with `append = "<extra>\n\n<body>"` |
 *
 * Other frontmatter fields map 1:1: `slug → id`, `name`, `description`,
 * `provider?`, `model`, `mcpServers?`, `maxTurns`, `disallowedTools?`,
 * `outputFormat?`, `scope?`. Reserved keys (`trigger`, `requires`,
 * `callableAs`, `consumes`) are preserved on `ManagedAgentMd.frontMatter`
 * for stops 7+ but not projected today.
 *
 * Frontmatter is strict: any key outside the projected + reserved
 * allowlist throws. This catches typos (`scopes:` for `scope:`,
 * `mcpServer:` for `mcpServers:`) that would otherwise silently parse
 * to the wrong semantics.
 */
export function toAgentDeclaration(md: ManagedAgentMd): AgentDeclaration {
    const fm = md.frontMatter;

    for (const key of Object.keys(fm)) {
        if (!PROJECTED_FRONTMATTER_KEYS.has(key) && !RESERVED_FRONTMATTER_KEYS.has(key)) {
            throw new Error(
                `managed-agents/${md.slug}.md: unknown frontmatter key "${key}" ` +
                `(allowed: ${[...PROJECTED_FRONTMATTER_KEYS, ...RESERVED_FRONTMATTER_KEYS].sort().join(', ')})`,
            );
        }
    }

    const slug = strField(fm, 'slug', md.slug);
    if (slug !== md.slug) {
        throw new Error(
            `managed-agents/${md.slug}.md: frontmatter slug "${slug}" disagrees with filename`,
        );
    }
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(slug)) {
        throw new Error(
            `managed-agents/${md.slug}.md: slug must match /^[a-z][a-z0-9-]{0,39}$/`,
        );
    }

    const provider = providerField(fm, slug);
    const systemPrompt = composeSystemPrompt(fm.systemPrompt, md.body, slug);
    const outputFormat = outputFormatField(fm, slug);
    const scope = strArrayField(fm, 'scope');
    const callableAs = strArrayField(fm, 'callableAs');

    return {
        id: slug,
        name: strField(fm, 'name'),
        description: strField(fm, 'description'),
        provider,
        model: strField(fm, 'model'),
        systemPrompt,
        maxTurns: intField(fm, 'maxTurns'),
        mcpServers: strArrayField(fm, 'mcpServers') ?? [],
        outputFormat,
        disallowedTools: strArrayField(fm, 'disallowedTools'),
        ...(scope !== undefined ? { scope } : {}),
        ...(callableAs !== undefined ? { callableAs } : {}),
    };
}

// ─── system prompt composition ────────────────────────────────────────────

function composeSystemPrompt(
    fmSystemPrompt: unknown,
    body: string,
    slug: string,
): SystemPromptConfig {
    if (body.length === 0) {
        throw new Error(
            `managed-agents/${slug}.md: body cannot be empty — it becomes the system prompt or the preset append`,
        );
    }
    if (fmSystemPrompt === undefined) {
        return body;
    }
    if (
        typeof fmSystemPrompt === 'object' &&
        fmSystemPrompt !== null &&
        !Array.isArray(fmSystemPrompt) &&
        (fmSystemPrompt as Record<string, unknown>).type === 'preset' &&
        (fmSystemPrompt as Record<string, unknown>).preset === 'claude_code'
    ) {
        const fmObj = fmSystemPrompt as { type: 'preset'; preset: 'claude_code'; append?: unknown };
        const fmAppend = fmObj.append;
        if (fmAppend !== undefined && typeof fmAppend !== 'string') {
            throw new Error(`managed-agents/${slug}.md: systemPrompt.append must be a string when present`);
        }
        const append = fmAppend ? `${fmAppend}\n\n${body}` : body;
        return { type: 'preset', preset: 'claude_code', append };
    }
    throw new Error(
        `managed-agents/${slug}.md: systemPrompt frontmatter must be omitted (body becomes the prompt) or { type: preset, preset: claude_code, append? }`,
    );
}

// ─── frontmatter readers ──────────────────────────────────────────────────

function strField(
    fm: Record<string, unknown>,
    key: string,
    fallback?: string,
): string {
    const v = fm[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (fallback !== undefined && v === undefined) return fallback;
    throw new Error(`managed-agents frontmatter: "${key}" must be a non-empty string`);
}

function intField(fm: Record<string, unknown>, key: string): number {
    const v = fm[key];
    if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
    throw new Error(`managed-agents frontmatter: "${key}" must be a positive integer`);
}

function strArrayField(
    fm: Record<string, unknown>,
    key: string,
): string[] | undefined {
    const v = fm[key];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || !v.every(x => typeof x === 'string')) {
        throw new Error(`managed-agents frontmatter: "${key}" must be an array of strings`);
    }
    return v as string[];
}

function providerField(
    fm: Record<string, unknown>,
    slug: string,
): 'ANTHROPIC' | 'OPEN_ROUTER' | undefined {
    const v = fm.provider;
    if (v === undefined) return undefined;
    if (v === 'ANTHROPIC' || v === 'OPEN_ROUTER') return v;
    throw new Error(
        `managed-agents/${slug}.md: provider must be "ANTHROPIC" or "OPEN_ROUTER"`,
    );
}

function outputFormatField(
    fm: Record<string, unknown>,
    slug: string,
): JsonSchemaOutputFormat | undefined {
    const v = fm.outputFormat;
    if (v === undefined) return undefined;
    if (
        typeof v !== 'object' ||
        v === null ||
        Array.isArray(v) ||
        (v as Record<string, unknown>).type !== 'json_schema'
    ) {
        throw new Error(
            `managed-agents/${slug}.md: outputFormat must be { type: "json_schema", schema: {...} }`,
        );
    }
    const o = v as Record<string, unknown>;
    if (typeof o.schema !== 'object' || o.schema === null || Array.isArray(o.schema)) {
        throw new Error(`managed-agents/${slug}.md: outputFormat.schema must be an object`);
    }
    return {
        type: 'json_schema',
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
        schema: o.schema as Record<string, unknown>,
    };
}
