# Ernesto

Ernesto is a skill-oriented context system for organizational agents.

## Model

Ernesto uses two operations:

1. `ask(query)`
- Discover relevant skills and indexed resources.

2. `get(routes)`
- Execute tools or load skill instructions/resources.

## Addressing

1. `skill`
- Returns the skill instruction and available tools.

2. `skill:tool`
- Executes a specific tool.

3. `skill://resources/path`
- Loads indexed resource content.

## Skill Structure

A skill contains:

1. Metadata (`name`, `description`, optional `version`, `tags`, `triggers`).
2. Instruction text (static or dynamic).
3. Tools (`SkillTool[]`).
4. Optional resource extractors.
5. Optional scope requirements.

## Design Principles

1. Uniformly discoverable tools.
2. Server-side execution and validation.
3. Workflow guidance through suggestions.
4. Scope-aware discovery and execution.

## Quick Example

```ts
const skill = createSkill({
  name: 'warehouse',
  description: 'Analytics workflows',
  instruction: 'Use investigate tools first, then specialized tools as needed.',
  tools: [investigateOrdersTool, queryOrdersTool],
});
```

```ts
await ask('orders yesterday');
await get([{ route: 'warehouse:investigate-orders', params: { day: '2026-02-18' } }]);
```

## Status

This repo now documents and implements the skill model directly.

## Troubleshooting builds

When switching between the legacy flat-file output (`dist/route.cjs`) and the
current per-route directory layout (`dist/route/`), stale artifacts from the
previous shape can shadow the new ones and surface as cryptic resolver errors.
Always wipe `dist/` before rebuilding: `rm -rf dist && pnpm build`.
