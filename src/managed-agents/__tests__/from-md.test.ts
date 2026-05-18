/**
 * Unit tests for the §7 managed-agents markdown reader.
 *
 * Covers:
 * - parseManagedAgentMd: happy path + missing/empty/invalid frontmatter.
 * - toAgentDeclaration: full field projection.
 * - System prompt composition: body-only vs preset+body + append concat.
 * - Field validation: slug regex, slug-filename agreement, provider
 *   enum, maxTurns positive int, mcpServers/disallowedTools shape,
 *   outputFormat shape.
 * - Strict frontmatter: unknown keys throw; reserved-but-unprojected
 *   keys (`trigger`, `requires`, `callableAs`, `consumes`) are accepted
 *   and kept on `ManagedAgentMd.frontMatter` for stops 7+.
 * - `scope` is projected onto `AgentDeclaration.scope` (§7.4 runtime
 *   narrowing).
 */
import { describe, it, expect } from 'vitest';
import {
    parseManagedAgentMd,
    toAgentDeclaration,
    composeExtends,
    MAX_EXTENDS_DEPTH,
    type ManagedAgentMd,
    type ExtendsResolver,
} from '../from-md';

const minimalRaw = (extra = ''): string => `---
slug: test-agent
name: Test Agent
description: For unit tests.
model: claude-haiku-4-5
maxTurns: 5${extra}
---

You are a test agent. Be concise.
`;

describe('parseManagedAgentMd', () => {
    it('parses a minimal valid file', () => {
        const md = parseManagedAgentMd(minimalRaw(), { slug: 'test-agent', workspace: 'qa' });
        expect(md.slug).toBe('test-agent');
        expect(md.workspace).toBe('qa');
        expect(md.frontMatter.name).toBe('Test Agent');
        expect(md.body).toBe('You are a test agent. Be concise.');
    });

    it('preserves reserved-but-unprojected frontmatter keys on the parsed shape', () => {
        const raw = `---
slug: a
name: A
description: d
model: claude-haiku-4-5
maxTurns: 1
trigger:
  kind: cron
  schedule: "0 9 * * 1"
requires: ["config.foo"]
consumes:
  - agent: someOther
---
body
`;
        const md = parseManagedAgentMd(raw, { slug: 'a', workspace: 'payments' });
        expect(md.frontMatter.trigger).toEqual({ kind: 'cron', schedule: '0 9 * * 1' });
        expect(md.frontMatter.requires).toEqual(['config.foo']);
        expect(md.frontMatter.consumes).toEqual([{ agent: 'someOther' }]);
    });

    it('rejects a file with no frontmatter delimiter', () => {
        expect(() =>
            parseManagedAgentMd('no frontmatter here', { slug: 'x', workspace: 'w' }),
        ).toThrow(/missing YAML frontmatter/);
    });

    it('rejects array-shaped frontmatter', () => {
        const raw = `---
- a
- b
---

body
`;
        expect(() => parseManagedAgentMd(raw, { slug: 'x', workspace: 'w' })).toThrow(
            /frontmatter must be a YAML object/,
        );
    });
});

describe('toAgentDeclaration — field projection', () => {
    it('projects all 1:1 fields', () => {
        const md = parseManagedAgentMd(
            minimalRaw('\nprovider: ANTHROPIC\nmcpServers: [ernesto]\ndisallowedTools: [Bash]'),
            { slug: 'test-agent', workspace: 'qa' },
        );
        const decl = toAgentDeclaration(md);
        expect(decl.id).toBe('test-agent');
        expect(decl.name).toBe('Test Agent');
        expect(decl.description).toBe('For unit tests.');
        expect(decl.provider).toBe('ANTHROPIC');
        expect(decl.model).toBe('claude-haiku-4-5');
        expect(decl.maxTurns).toBe(5);
        expect(decl.mcpServers).toEqual(['ernesto']);
        expect(decl.disallowedTools).toEqual(['Bash']);
    });

    it('defaults mcpServers to [] and leaves provider/disallowedTools/outputFormat undefined', () => {
        const md = parseManagedAgentMd(minimalRaw(), { slug: 'test-agent', workspace: 'qa' });
        const decl = toAgentDeclaration(md);
        expect(decl.mcpServers).toEqual([]);
        expect(decl.provider).toBeUndefined();
        expect(decl.disallowedTools).toBeUndefined();
        expect(decl.outputFormat).toBeUndefined();
    });

    it('projects outputFormat when valid', () => {
        const raw = `---
slug: a
name: A
description: d
model: claude-haiku-4-5
maxTurns: 1
outputFormat:
  type: json_schema
  name: weekly
  schema:
    type: object
    properties:
      summary: { type: string }
---
body
`;
        const decl = toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'a', workspace: 'w' }));
        expect(decl.outputFormat).toEqual({
            type: 'json_schema',
            name: 'weekly',
            schema: {
                type: 'object',
                properties: { summary: { type: 'string' } },
            },
        });
    });
});

describe('toAgentDeclaration — system prompt composition', () => {
    it('body becomes the string system prompt when frontmatter has no systemPrompt', () => {
        const md = parseManagedAgentMd(minimalRaw(), { slug: 'test-agent', workspace: 'qa' });
        const decl = toAgentDeclaration(md);
        expect(decl.systemPrompt).toBe('You are a test agent. Be concise.');
    });

    it('preset with no append uses body as the append', () => {
        const raw = `---
slug: a
name: A
description: d
model: claude-haiku-4-5
maxTurns: 1
systemPrompt:
  type: preset
  preset: claude_code
---

body content
`;
        const decl = toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'a', workspace: 'w' }));
        expect(decl.systemPrompt).toEqual({
            type: 'preset',
            preset: 'claude_code',
            append: 'body content',
        });
    });

    it('preset with an existing append concatenates with body via \\n\\n', () => {
        const raw = `---
slug: a
name: A
description: d
model: claude-haiku-4-5
maxTurns: 1
systemPrompt:
  type: preset
  preset: claude_code
  append: "Existing override."
---

Body line one.
Body line two.
`;
        const decl = toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'a', workspace: 'w' }));
        expect(decl.systemPrompt).toEqual({
            type: 'preset',
            preset: 'claude_code',
            append: 'Existing override.\n\nBody line one.\nBody line two.',
        });
    });

    it('rejects empty body', () => {
        const raw = `---
slug: a
name: A
description: d
model: claude-haiku-4-5
maxTurns: 1
---


`;
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'a', workspace: 'w' }))).toThrow(
            /body cannot be empty/,
        );
    });

    it('rejects unknown systemPrompt shapes', () => {
        const raw = `---
slug: a
name: A
description: d
model: claude-haiku-4-5
maxTurns: 1
systemPrompt:
  type: not-a-preset
---
body
`;
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'a', workspace: 'w' }))).toThrow(
            /systemPrompt frontmatter/,
        );
    });
});

describe('toAgentDeclaration — validation', () => {
    it('rejects slug-filename disagreement', () => {
        const raw = minimalRaw().replace('slug: test-agent', 'slug: other-name');
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }))).toThrow(
            /slug "other-name" disagrees with filename/,
        );
    });

    it('rejects bad slug regex', () => {
        const raw = minimalRaw().replace('slug: test-agent', 'slug: BadSlugWithCaps');
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'BadSlugWithCaps', workspace: 'w' }))).toThrow(
            /must match/,
        );
    });

    it('rejects unknown provider', () => {
        const raw = minimalRaw('\nprovider: GOOGLE');
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }))).toThrow(
            /provider must be/,
        );
    });

    it('rejects non-positive maxTurns', () => {
        const raw = minimalRaw().replace('maxTurns: 5', 'maxTurns: 0');
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }))).toThrow(
            /must be a positive integer/,
        );
    });

    it('rejects malformed mcpServers (object instead of array)', () => {
        const raw = minimalRaw('\nmcpServers: {a: 1}');
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }))).toThrow(
            /must be an array of strings/,
        );
    });

    it('rejects outputFormat without type: json_schema', () => {
        const raw = minimalRaw('\noutputFormat:\n  schema: {type: object}');
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }))).toThrow(
            /outputFormat must be/,
        );
    });

    it('rejects unknown frontmatter keys (catches typos like `scopes`)', () => {
        const raw = minimalRaw('\nscopes: ["payments:read"]');
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }))).toThrow(
            /unknown frontmatter key "scopes"/,
        );
    });

    it('accepts reserved-but-unprojected keys without throwing', () => {
        const raw = minimalRaw('\ntrigger: {kind: manual}\nrequires: []\nconsumes: []');
        const decl = toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }));
        expect(decl.id).toBe('test-agent');
        expect(decl.scope).toBeUndefined();
    });

    it('projects callableAs onto AgentDeclaration.callableAs (§7.12)', () => {
        const raw = minimalRaw('\ncallableAs: [subagent]');
        const decl = toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }));
        expect(decl.callableAs).toEqual(['subagent']);
    });

    it('leaves callableAs undefined when absent (default: not callable as subagent)', () => {
        const md = parseManagedAgentMd(minimalRaw(), { slug: 'test-agent', workspace: 'w' });
        const decl = toAgentDeclaration(md);
        expect(decl.callableAs).toBeUndefined();
    });

    it('projects scope onto AgentDeclaration.scope', () => {
        const raw = minimalRaw('\nscope: ["payments:read", "payments:write"]');
        const decl = toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }));
        expect(decl.scope).toEqual(['payments:read', 'payments:write']);
    });

    it('rejects scope that is not a string array', () => {
        const raw = minimalRaw('\nscope: "payments:read"');
        expect(() => toAgentDeclaration(parseManagedAgentMd(raw, { slug: 'test-agent', workspace: 'w' }))).toThrow(
            /must be an array of strings/,
        );
    });
});

// ─── §7.13.5 composeExtends ───────────────────────────────────────────────

describe('composeExtends (§7.13.5)', () => {
    // Helper to make a resolver from a list of base files.
    const resolverFrom = (bases: ManagedAgentMd[]): ExtendsResolver =>
        (ws, slug) => bases.find((b) => b.workspace === ws && b.slug === slug);

    const baseRaw = (slug: string, body = 'Base body line.'): string => `---
slug: ${slug}
name: ${slug} base
description: shared base
model: claude-haiku-4-5
maxTurns: 8
mcpServers: [ernesto]
outputFormat:
  type: json_schema
  name: base_schema
  schema:
    type: object
    properties:
      ok: { type: boolean }
    required: [ok]
---

${body}
`;

    it('returns input unchanged when no extends key is set', () => {
        const md = parseManagedAgentMd(minimalRaw(), { slug: 'test-agent', workspace: 'w' });
        const out = composeExtends(md, { resolveBase: () => undefined });
        expect(out).toBe(md);
    });

    it('rejects extends as a non-string value', () => {
        const md = parseManagedAgentMd(minimalRaw('\nextends: 42'), {
            slug: 'test-agent',
            workspace: 'w',
        });
        expect(() => composeExtends(md, { resolveBase: () => undefined })).toThrow(
            /"extends" must be a non-empty string slug/,
        );
    });

    it('throws extends_target_not_found when the resolver returns undefined', () => {
        const md = parseManagedAgentMd(minimalRaw('\nextends: missing-base'), {
            slug: 'test-agent',
            workspace: 'w',
        });
        expect(() => composeExtends(md, { resolveBase: () => undefined })).toThrow(
            /extends_target_not_found: w\/missing-base/,
        );
    });

    it('rejects a resolver that returns a base in another workspace', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base'), {
            slug: 'shared-base',
            workspace: 'other',
        });
        const md = parseManagedAgentMd(minimalRaw('\nextends: shared-base'), {
            slug: 'test-agent',
            workspace: 'w',
        });
        expect(() =>
            composeExtends(md, { resolveBase: () => base }),
        ).toThrow(/cross-workspace extends not allowed/);
    });

    it('concatenates base body and local body with a blank line', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base', 'BASE PROSE.'), {
            slug: 'shared-base',
            workspace: 'w',
        });
        const local = parseManagedAgentMd(
            `---
slug: ext
name: Ext
description: extends shared-base
extends: shared-base
---

LOCAL PROSE.
`,
            { slug: 'ext', workspace: 'w' },
        );
        const composed = composeExtends(local, { resolveBase: resolverFrom([base]) });
        expect(composed.body).toBe('BASE PROSE.\n\nLOCAL PROSE.');
    });

    it('falls back to base body alone when extender has empty body', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base', 'BASE PROSE.'), {
            slug: 'shared-base',
            workspace: 'w',
        });
        // Local body is whitespace-only — parser trims to empty string.
        const local = parseManagedAgentMd(
            `---
slug: ext
name: Ext
description: pure-override case
model: claude-sonnet-4-6
extends: shared-base
---


`,
            { slug: 'ext', workspace: 'w' },
        );
        const composed = composeExtends(local, { resolveBase: resolverFrom([base]) });
        expect(composed.body).toBe('BASE PROSE.');
        // The local override on model still applies through the merge.
        expect(composed.frontMatter.model).toBe('claude-sonnet-4-6');
    });

    it('strips the extends key from the composed frontmatter', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base'), {
            slug: 'shared-base',
            workspace: 'w',
        });
        const local = parseManagedAgentMd(
            `---
slug: ext
name: Ext
description: d
extends: shared-base
---

local
`,
            { slug: 'ext', workspace: 'w' },
        );
        const composed = composeExtends(local, { resolveBase: resolverFrom([base]) });
        expect(composed.frontMatter.extends).toBeUndefined();
    });

    it('inherits model/maxTurns/mcpServers/outputFormat when extender omits them', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base'), {
            slug: 'shared-base',
            workspace: 'w',
        });
        const local = parseManagedAgentMd(
            `---
slug: ext
name: Ext
description: d
extends: shared-base
---

local
`,
            { slug: 'ext', workspace: 'w' },
        );
        const composed = composeExtends(local, { resolveBase: resolverFrom([base]) });
        const decl = toAgentDeclaration(composed);
        expect(decl.model).toBe('claude-haiku-4-5');
        expect(decl.maxTurns).toBe(8);
        expect(decl.mcpServers).toEqual(['ernesto']);
        expect(decl.outputFormat?.name).toBe('base_schema');
    });

    it('local overrides win for outputFormat (atomic, no deep merge)', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base'), {
            slug: 'shared-base',
            workspace: 'w',
        });
        const local = parseManagedAgentMd(
            `---
slug: ext
name: Ext
description: d
extends: shared-base
outputFormat:
  type: json_schema
  name: local_schema
  schema:
    type: object
    properties:
      different: { type: string }
---

local
`,
            { slug: 'ext', workspace: 'w' },
        );
        const composed = composeExtends(local, { resolveBase: resolverFrom([base]) });
        const decl = toAgentDeclaration(composed);
        expect(decl.outputFormat?.name).toBe('local_schema');
        expect(decl.outputFormat?.schema).toEqual({
            type: 'object',
            properties: { different: { type: 'string' } },
        });
    });

    it('local overrides win for mcpServers (no array concat)', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base'), {
            slug: 'shared-base',
            workspace: 'w',
        });
        const local = parseManagedAgentMd(
            `---
slug: ext
name: Ext
description: d
extends: shared-base
mcpServers: [firecrawl, playwright]
---

local
`,
            { slug: 'ext', workspace: 'w' },
        );
        const composed = composeExtends(local, { resolveBase: resolverFrom([base]) });
        const decl = toAgentDeclaration(composed);
        expect(decl.mcpServers).toEqual(['firecrawl', 'playwright']);
    });

    it('local overrides win for scope (no union)', () => {
        const baseSrc = `---
slug: shared-base
name: shared-base base
description: shared base
model: claude-haiku-4-5
maxTurns: 5
scope: ["payments:read"]
---

base
`;
        const base = parseManagedAgentMd(baseSrc, { slug: 'shared-base', workspace: 'w' });
        const local = parseManagedAgentMd(
            `---
slug: ext
name: Ext
description: d
extends: shared-base
scope: ["payments:write"]
---

local
`,
            { slug: 'ext', workspace: 'w' },
        );
        const composed = composeExtends(local, { resolveBase: resolverFrom([base]) });
        const decl = toAgentDeclaration(composed);
        expect(decl.scope).toEqual(['payments:write']);
    });

    it('requires the extender to set its own slug', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base'), {
            slug: 'shared-base',
            workspace: 'w',
        });
        const raw = `---
name: Ext
description: d
extends: shared-base
---

local
`;
        const md = parseManagedAgentMd(raw, { slug: 'ext', workspace: 'w' });
        expect(() =>
            composeExtends(md, { resolveBase: resolverFrom([base]) }),
        ).toThrow(/"slug" must be set on the extending file/);
    });

    it('requires the extender to set its own name', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base'), {
            slug: 'shared-base',
            workspace: 'w',
        });
        const raw = `---
slug: ext
description: d
extends: shared-base
---

local
`;
        const md = parseManagedAgentMd(raw, { slug: 'ext', workspace: 'w' });
        expect(() =>
            composeExtends(md, { resolveBase: resolverFrom([base]) }),
        ).toThrow(/"name" must be set on the extending file/);
    });

    it('requires the extender to set its own description', () => {
        const base = parseManagedAgentMd(baseRaw('shared-base'), {
            slug: 'shared-base',
            workspace: 'w',
        });
        const raw = `---
slug: ext
name: Ext
extends: shared-base
---

local
`;
        const md = parseManagedAgentMd(raw, { slug: 'ext', workspace: 'w' });
        expect(() =>
            composeExtends(md, { resolveBase: resolverFrom([base]) }),
        ).toThrow(/"description" must be set on the extending file/);
    });

    it('detects A → B → A cycles and prints the full path', () => {
        const aSrc = `---
slug: a
name: A
description: d
extends: b
---

a body
`;
        const bSrc = `---
slug: b
name: B
description: d
model: claude-haiku-4-5
maxTurns: 5
extends: a
---

b body
`;
        const a = parseManagedAgentMd(aSrc, { slug: 'a', workspace: 'w' });
        const b = parseManagedAgentMd(bSrc, { slug: 'b', workspace: 'w' });
        expect(() =>
            composeExtends(a, { resolveBase: resolverFrom([a, b]) }),
        ).toThrow(/extends cycle detected \(w\/a → w\/b → w\/a\)/);
    });

    it('detects self-cycles (A extends A)', () => {
        const aSrc = `---
slug: a
name: A
description: d
model: claude-haiku-4-5
maxTurns: 5
extends: a
---

body
`;
        const a = parseManagedAgentMd(aSrc, { slug: 'a', workspace: 'w' });
        expect(() =>
            composeExtends(a, { resolveBase: resolverFrom([a]) }),
        ).toThrow(/extends cycle detected \(w\/a → w\/a\)/);
    });

    it(`enforces the MAX_EXTENDS_DEPTH (${MAX_EXTENDS_DEPTH}) cap`, () => {
        // Build a linear chain of MAX+2 files: a → b → c → d → e.
        // a..d each "extends" the next; e is plain. The 4th hop (d→e)
        // breaches the cap when MAX_EXTENDS_DEPTH=3.
        const mkChain = (slug: string, ext?: string) => {
            const extLine = ext ? `\nextends: ${ext}` : '';
            return parseManagedAgentMd(
                `---
slug: ${slug}
name: ${slug.toUpperCase()}
description: d
model: claude-haiku-4-5
maxTurns: 5${extLine}
---

${slug} body
`,
                { slug, workspace: 'w' },
            );
        };
        const e = mkChain('e');
        const d = mkChain('d', 'e');
        const c = mkChain('c', 'd');
        const b = mkChain('b', 'c');
        const a = mkChain('a', 'b');
        expect(() =>
            composeExtends(a, { resolveBase: resolverFrom([a, b, c, d, e]) }),
        ).toThrow(/extends chain exceeds max_extends_depth=3/);
    });

    it('allows a chain at the cap (3 hops)', () => {
        const mkChain = (slug: string, ext?: string) => {
            const extLine = ext ? `\nextends: ${ext}` : '';
            return parseManagedAgentMd(
                `---
slug: ${slug}
name: ${slug.toUpperCase()}
description: d
model: claude-haiku-4-5
maxTurns: 5${extLine}
---

${slug} body
`,
                { slug, workspace: 'w' },
            );
        };
        const d = mkChain('d');
        const c = mkChain('c', 'd');
        const b = mkChain('b', 'c');
        const a = mkChain('a', 'b');
        const composed = composeExtends(a, {
            resolveBase: resolverFrom([a, b, c, d]),
        });
        // Body order: deepest first, extender last.
        expect(composed.body).toBe('d body\n\nc body\n\nb body\n\na body');
    });

    it('composes transitively (A → B → C; C contributes the schema)', () => {
        const cSrc = `---
slug: c
name: C base
description: deep base
model: claude-haiku-4-5
maxTurns: 10
outputFormat:
  type: json_schema
  name: deep_schema
  schema: { type: object }
---

C prose.
`;
        const bSrc = `---
slug: b
name: B middle
description: middle
extends: c
mcpServers: [ernesto]
---

B prose.
`;
        const aSrc = `---
slug: a
name: A extender
description: top
extends: b
---

A prose.
`;
        const c = parseManagedAgentMd(cSrc, { slug: 'c', workspace: 'w' });
        const b = parseManagedAgentMd(bSrc, { slug: 'b', workspace: 'w' });
        const a = parseManagedAgentMd(aSrc, { slug: 'a', workspace: 'w' });
        const composed = composeExtends(a, { resolveBase: resolverFrom([a, b, c]) });
        const decl = toAgentDeclaration(composed);
        expect(composed.body).toBe('C prose.\n\nB prose.\n\nA prose.');
        expect(decl.outputFormat?.name).toBe('deep_schema');
        expect(decl.mcpServers).toEqual(['ernesto']);
    });

    it('toAgentDeclaration rejects un-composed extends with a clear error', () => {
        const raw = `---
slug: ext
name: Ext
description: d
model: claude-haiku-4-5
maxTurns: 5
extends: some-base
---

body
`;
        const md = parseManagedAgentMd(raw, { slug: 'ext', workspace: 'w' });
        expect(() => toAgentDeclaration(md)).toThrow(
            /"extends" must be resolved by composeExtends/,
        );
    });
});
