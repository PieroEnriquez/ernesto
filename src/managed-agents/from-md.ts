import { load as yamlLoad } from 'js-yaml';
import { readFrontmatter } from '../frontmatter';
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
    'slug', 'name', 'description', 'provider', 'harness', 'model',
    'systemPrompt', 'maxTurns', 'mcpServers', 'outputFormat',
    'disallowedTools', 'scope', 'callableAs', 'subagents',
]);
const RESERVED_FRONTMATTER_KEYS = new Set([
    'trigger', 'requires', 'consumes',
]);

/**
 * §7.13.5 — `extends:` is parsed and kept on `frontMatter` until
 * `composeExtends` resolves the chain. After composition the key is
 * stripped; reaching `toAgentDeclaration` with `extends:` still set
 * throws (the allowlist below excludes it) so callers can't forget
 * to compose.
 */
const COMPOSITION_FRONTMATTER_KEYS = new Set(['extends']);

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
    const { frontMatter, body } = readFrontmatter(raw);
    if (frontMatter === '') {
        throw new Error(
            `managed-agents/${opts.slug}.md: missing YAML frontmatter (file must begin with "---")`,
        );
    }
    const fm = yamlLoad(frontMatter);
    if (!fm || typeof fm !== 'object' || Array.isArray(fm)) {
        throw new Error(
            `managed-agents/${opts.slug}.md: frontmatter must be a YAML object`,
        );
    }
    return {
        slug: opts.slug,
        workspace: opts.workspace,
        frontMatter: fm as Record<string, unknown>,
        body: body.trim(),
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
        if (
            !PROJECTED_FRONTMATTER_KEYS.has(key) &&
            !RESERVED_FRONTMATTER_KEYS.has(key)
        ) {
            if (COMPOSITION_FRONTMATTER_KEYS.has(key)) {
                throw new Error(
                    `managed-agents/${md.slug}.md: "extends" must be resolved by composeExtends before toAgentDeclaration (§7.13.5)`,
                );
            }
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
    const harness = harnessField(fm, slug);
    const systemPrompt = composeSystemPrompt(fm.systemPrompt, md.body, slug);
    const outputFormat = outputFormatField(fm, slug);
    const scope = strArrayField(fm, 'scope');
    const callableAs = strArrayField(fm, 'callableAs');
    const subagents = subagentsField(fm, slug);

    return {
        id: slug,
        name: strField(fm, 'name'),
        description: strField(fm, 'description'),
        ...(harness !== undefined ? { harness } : {}),
        provider,
        model: strField(fm, 'model'),
        systemPrompt,
        maxTurns: intField(fm, 'maxTurns'),
        mcpServers: strArrayField(fm, 'mcpServers') ?? [],
        outputFormat,
        disallowedTools: strArrayField(fm, 'disallowedTools'),
        ...(scope !== undefined ? { scope } : {}),
        ...(callableAs !== undefined ? { callableAs } : {}),
        ...(subagents !== undefined ? { subagents } : {}),
    };
}

/** Project `subagents: { <slug>: { ref: <workflow-name> } }`. Shape-
 *  validates each entry; deeper resolution (does `ref` resolve to a
 *  known workflow?) belongs to wire-fragua's `resolveSubagents`. */
function subagentsField(
    fm: Record<string, unknown>,
    slug: string,
): Record<string, { ref: string }> | undefined {
    const raw = fm.subagents;
    if (raw === undefined) return undefined;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(
            `managed-agents/${slug}.md: frontmatter "subagents" must be an object mapping slug → { ref }`,
        );
    }
    const out: Record<string, { ref: string }> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error(
                `managed-agents/${slug}.md: subagents.${key} must be an object with a "ref" string`,
            );
        }
        const ref = (value as { ref?: unknown }).ref;
        if (typeof ref !== 'string' || ref.length === 0) {
            throw new Error(
                `managed-agents/${slug}.md: subagents.${key}.ref must be a non-empty string`,
            );
        }
        out[key] = { ref };
    }
    return out;
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

function harnessField(
    fm: Record<string, unknown>,
    slug: string,
): 'cas' | 'cursor' | 'fragua-pi' | undefined {
    const v = fm.harness;
    if (v === undefined) return undefined;
    if (v === 'cas' || v === 'cursor' || v === 'fragua-pi') return v;
    throw new Error(
        `managed-agents/${slug}.md: harness must be "cas" | "cursor" | "fragua-pi"`,
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

// ─── §7.13.5 extends resolver ─────────────────────────────────────────────

/**
 * Caller-supplied lookup for `extends:` resolution. Returns the parsed
 * `ManagedAgentMd` for `<workspace>/<slug>`, or `undefined` if the base
 * isn't authored / approved / loaded in the caller's source-of-truth.
 *
 * The backend registry resolves against an in-memory map of all active
 * `ManagedAgentApproval` rows; the approve route resolves against a
 * pre-fetched chain pulled from Mongo. Either way the resolver is sync
 * — `composeExtends` is structural composition, not I/O.
 */
export type ExtendsResolver = (
    workspace: string,
    slug: string,
) => ManagedAgentMd | undefined;

/**
 * §7.13.5 — max length of an `extends:` chain (hops between files).
 * `A extends B extends C extends D` is 3 hops; one further hop throws.
 * The cap is intentionally low: deeper trees suggest the base itself
 * wants splitting, not a longer chain.
 */
export const MAX_EXTENDS_DEPTH = 3;

/**
 * §7.13.5 — the only workspace permitted as a cross-workspace `extends:`
 * base. `_platform` is already the canonical "library" workspace
 * (it owns `_platform://task`, `_platform://list-dashboards`, etc.),
 * so re-using it for shared agent bases keeps the boundary in one
 * place. Any other cross-workspace extends is rejected.
 */
export const PLATFORM_WORKSPACE = '_platform';

/**
 * §7.13.5 — parse an `extends:` value into a (workspace, slug) pair.
 *
 * Two accepted forms:
 *   - `<slug>`                — resolves in the extender's own workspace.
 *   - `<workspace>/<slug>`    — resolves in the named workspace. Only
 *                               `_platform` is accepted as a non-self
 *                               workspace; any other prefix throws.
 *
 * Slug-only is the historical form and stays the recommendation for
 * same-workspace bases (legibility + grep). The qualified form is the
 * only way to reach the platform-level shared bases.
 */
function parseExtendsKey(
    extendsKey: string,
    md: ManagedAgentMd,
): { workspace: string; slug: string } {
    if (!extendsKey.includes('/')) {
        return { workspace: md.workspace, slug: extendsKey };
    }
    const parts = extendsKey.split('/');
    if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
        throw new Error(
            `managed-agents/${md.slug}.md: "extends" must be "<slug>" or "<workspace>/<slug>" ` +
            `(got ${JSON.stringify(extendsKey)})`,
        );
    }
    return { workspace: parts[0], slug: parts[1] };
}

/**
 * §7.13.5 — resolve the `extends:` chain on `md` and return a
 * synthetic, fully-composed `ManagedAgentMd` ready for `toAgentDeclaration`.
 * If `md` has no `extends:` key, returns `md` unchanged.
 *
 * **Composition semantics.**
 * - Body: `<base.body>\n\n<local.body>`. An empty local body falls
 *   back to the base body alone (pure-override case: same prompt,
 *   different model).
 * - Frontmatter: local overrides per-key. `outputFormat`, `mcpServers`,
 *   `disallowedTools`, `maxTurns`, `provider`, `model`, `scope`,
 *   `callableAs`, `trigger`, `requires`, `consumes` all follow the
 *   same rule — atomic override, no deep merge. The `extends:` key
 *   itself is stripped from the composed result.
 * - `slug`, `name`, `description` MUST be set on the extending file
 *   (no inheritance). These identify the agent in the registry.
 *
 * **Guards.**
 * - Cycle detection on `<workspace>/<slug>` path; throws with the
 *   full path printed (`ws/a → ws/b → ws/a`).
 * - Depth cap `MAX_EXTENDS_DEPTH`; throws on overflow.
 * - Same-workspace by default; `_platform` (`PLATFORM_WORKSPACE`) is
 *   the one accepted cross-workspace base, reachable via the
 *   `_platform/<slug>` qualified form. Any other cross-workspace
 *   target throws.
 * - Missing base → `extends_target_not_found: <workspace>/<slug>`.
 */
export function composeExtends(
    md: ManagedAgentMd,
    opts: { resolveBase: ExtendsResolver },
): ManagedAgentMd {
    return composeExtendsInner(md, opts.resolveBase, []);
}

function composeExtendsInner(
    md: ManagedAgentMd,
    resolveBase: ExtendsResolver,
    chain: string[],
): ManagedAgentMd {
    const nodeKey = `${md.workspace}/${md.slug}`;
    if (chain.includes(nodeKey)) {
        throw new Error(
            `managed-agents/${md.slug}.md: extends cycle detected ` +
            `(${[...chain, nodeKey].join(' → ')})`,
        );
    }

    const extendsKey = md.frontMatter.extends;
    if (extendsKey === undefined) {
        return md;
    }
    if (typeof extendsKey !== 'string' || extendsKey.length === 0) {
        throw new Error(
            `managed-agents/${md.slug}.md: "extends" must be a non-empty string slug ` +
            `(got ${JSON.stringify(extendsKey)})`,
        );
    }
    const { workspace: baseWorkspace, slug: baseSlug } = parseExtendsKey(extendsKey, md);

    if (baseWorkspace !== md.workspace && baseWorkspace !== PLATFORM_WORKSPACE) {
        throw new Error(
            `managed-agents/${md.slug}.md: cross-workspace extends only allowed from ` +
            `"${PLATFORM_WORKSPACE}" (got ${md.workspace} → ${baseWorkspace}/${baseSlug})`,
        );
    }

    if (chain.length >= MAX_EXTENDS_DEPTH) {
        throw new Error(
            `managed-agents/${md.slug}.md: extends chain exceeds ` +
            `max_extends_depth=${MAX_EXTENDS_DEPTH} ` +
            `(${[...chain, nodeKey, `${baseWorkspace}/${baseSlug}`].join(' → ')})`,
        );
    }

    const baseRaw = resolveBase(baseWorkspace, baseSlug);
    if (!baseRaw) {
        throw new Error(
            `managed-agents/${md.slug}.md: extends_target_not_found: ${baseWorkspace}/${baseSlug}`,
        );
    }
    // Resolver integrity: returned base must match what we asked for.
    // Catches buggy resolvers that silently return a wrong-workspace row
    // (the same shape the old "cross-workspace extends not allowed"
    // check guarded against — kept here as a hard assertion).
    if (baseRaw.workspace !== baseWorkspace || baseRaw.slug !== baseSlug) {
        throw new Error(
            `managed-agents/${md.slug}.md: resolver returned wrong base ` +
            `(asked for ${baseWorkspace}/${baseSlug}, got ${baseRaw.workspace}/${baseRaw.slug})`,
        );
    }

    // Required-on-local: slug/name/description identify the agent and
    // must be set on the extending file directly. We check this on the
    // extender's *own* frontmatter (pre-merge); after merge the values
    // would always appear (inherited from base) and the validation in
    // toAgentDeclaration would pass silently against the wrong values.
    for (const key of ['slug', 'name', 'description']) {
        const v = md.frontMatter[key];
        if (typeof v !== 'string' || v.length === 0) {
            throw new Error(
                `managed-agents/${md.slug}.md: "${key}" must be set on the extending file ` +
                `(no inheritance from "${baseRaw.workspace}/${baseRaw.slug}")`,
            );
        }
    }

    // Recurse first so the base is itself fully composed (transitive
    // chains: A extends B extends C → base passed to the merge below
    // already has C's body + frontmatter folded into B's).
    const base = composeExtendsInner(baseRaw, resolveBase, [...chain, nodeKey]);

    // Frontmatter merge: local overrides per key. The `extends:` key
    // itself is stripped — it's already been resolved into this very
    // composition and is not inheritable (§7.13.5).
    const merged: Record<string, unknown> = { ...base.frontMatter };
    delete merged.extends;
    for (const [k, v] of Object.entries(md.frontMatter)) {
        if (k === 'extends') continue;
        merged[k] = v;
    }

    // Body merge. Empty extender body → base body alone (allows the
    // "same prompt, different model" pattern). Empty base body →
    // extender body alone. Both populated → join with a blank line.
    let composedBody: string;
    if (md.body.length === 0) {
        composedBody = base.body;
    } else if (base.body.length === 0) {
        composedBody = md.body;
    } else {
        composedBody = `${base.body}\n\n${md.body}`;
    }

    return {
        slug: md.slug,
        workspace: md.workspace,
        frontMatter: merged,
        body: composedBody,
    };
}
