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
 * - Forward compatibility: frontmatter-only fields (`trigger`, `scope`,
 *   `requires`, `callableAs`, `consumes`) are preserved on the parsed
 *   `ManagedAgentMd` but not projected — stops 6+ will read them.
 */
import { describe, it, expect } from 'vitest';
import { parseManagedAgentMd, toAgentDeclaration } from '../from-md';

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

    it('preserves forward-compat frontmatter fields without projecting them', () => {
        const raw = `---
slug: a
name: A
description: d
model: claude-haiku-4-5
maxTurns: 1
trigger:
  kind: cron
  schedule: "0 9 * * 1"
scope: ["payments:read"]
requires: ["config.foo"]
callableAs: [subagent]
consumes:
  - agent: someOther
---
body
`;
        const md = parseManagedAgentMd(raw, { slug: 'a', workspace: 'payments' });
        expect(md.frontMatter.trigger).toEqual({ kind: 'cron', schedule: '0 9 * * 1' });
        expect(md.frontMatter.scope).toEqual(['payments:read']);
        expect(md.frontMatter.requires).toEqual(['config.foo']);
        expect(md.frontMatter.callableAs).toEqual(['subagent']);
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
});
