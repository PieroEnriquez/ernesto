# Ernesto Reference

Current reference for Ernesto's skill model.

## API Surface

1. `ask(query, domain?, perDomain?)`
- Semantic discovery over skills + resources.

2. `get(routes[])`
- Batch execution for tools and resource loads.

## Route Formats

1. `skill`
- Return skill instruction and tool catalog.

2. `skill:tool`
- Execute one tool.

3. `skill://resources/path`
- Read one indexed resource.

## Tool Contract

`SkillTool<TInput>` fields:

1. `name`
2. `description`
3. `execute(params, ctx) => Promise<ToolResult>`
4. Optional `inputSchema`
5. Optional `requiredScopes`
6. Optional `freshness`
7. Optional static `connections`

## ToolResult

1. `content: string`
2. Optional `structured: unknown`
3. Optional `suggestions: Suggestion[]`

## Scope Enforcement

1. Skill scopes checked before skill/tool access.
2. Tool scopes checked before execute.
3. Resource scopes checked before read.

## Search Behavior

1. Skills are included as semantic entries.
2. Resources are queried from Typesense with optional segment config.
3. Domain filter narrows search to one skill/domain.

## Execution Behavior

1. `get` executes routes independently.
2. Results include per-route success/failure.
3. Input validation runs from Zod schema when present.
4. Permission failures return explicit messages.

## Suggested Verification Commands

```bash
pnpm test
```

```bash
pnpm build
```
