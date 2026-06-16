export const meta = {
  name: 'ernesto-fragua-gap',
  description: 'Map ernesto workflow-engine requirements vs fragua exposed surface, synthesize and verify recommendations for fragua as a Node.js lib',
  phases: [
    { title: 'Map' },
    { title: 'Synthesize' },
    { title: 'Verify' },
  ],
}

const ROOT = '/Users/trb/Bitrefill/ernesto_staging'

const MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['area', 'summary', 'findings', 'constraints'],
  properties: {
    area: { type: 'string' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['capability', 'detail', 'evidence'],
        properties: {
          capability: { type: 'string', description: 'short name of the capability/requirement/exposed surface' },
          detail: { type: 'string', description: 'what it does and why it matters for the engine swap' },
          evidence: { type: 'string', description: 'file path(s) and symbol/line refs' },
        },
      },
    },
    constraints: {
      type: 'array',
      items: { type: 'string' },
      description: 'hard constraints, couplings, or non-negotiable requirements',
    },
  },
}

phase('Map')

const briefs = [
  {
    label: 'map:ernesto-engine',
    prompt: `You are mapping the CURRENT workflow engine of "ernesto" (a Bitrefill org-agent platform) so another team can replace it with their engine "fragua". Read code under ${ROOT}/lib/src/workflow-engine (a full TypeScript repo; read freely with Read/Grep/Glob/Bash).

Produce a precise map of EVERY capability the ernesto engine embodies — these become REQUIREMENTS a replacement engine must satisfy. Cover, with file:line evidence:
- The dispatch entry point and its signature/return type: dispatch.ts, runner.ts, types/runner.ts. What is Run<T>? sync vs async? streaming?
- kind-registry.ts: what "kinds" exist (route, workflow, managed-agent, dashboard, dynamic-workflow, group, input, agent) and how resolve(kind) works.
- The middleware chain (middleware.ts + middleware/*.ts): for EACH middleware (logging, scope-check, idempotency-dedup, result-cache, workspace-result-cache, timeout, model-router, workspace-allocator, sandbox-bind, tool-surface-compose, event-log-init) state precisely what it does, what state it reads/writes, and where it sits in the order. This is the core of the gap analysis.
- The DAG walker: engine/run-graph.ts, engine/walker.ts, engine/render-projection.ts. How steps are scheduled, step kinds, fan-out, parallelism, recursion (group).
- event-bus.ts + types/event.ts: the fact.* event taxonomy, what's emitted at each transition.
- store/port.ts + store/in-memory-store.ts: the persistence interface (the PORT abstraction). What must a store implement? Is it pluggable?
- hitl.ts: human-in-the-loop pause/resume model.
- cost-rollup.ts, conversation-state.ts, tier-port.ts, step-emissions.ts, principal.ts, workflow-reader.ts: what each provides.
- handlers/route-step.ts and types/handler.ts: the handler contract.

Be exhaustive on the middleware and the store port — those are where ernesto's needs diverge most from a generic engine. Return structured output per the schema.`,
  },
  {
    label: 'map:ernesto-artifacts-harness',
    prompt: `You are mapping how "ernesto" (a Bitrefill org-agent platform) declares & compiles its callable artifacts and abstracts its LLM execution backends ("harnesses"), so another team building engine "fragua" knows what to support. Read under ${ROOT}/lib/src (full TypeScript repo; Read/Grep/Glob/Bash freely). Focus dirs: workflows/, managed-agents/, dashboards/, harness/, route/, workdir/, lint/, components/, ui-tools/, route-results/.

Cover with file:line evidence:
- workflows/: parse.ts, parse-dynamic-js.ts, compile-managed-agent.ts, compile-dashboard.ts, validate.ts, types.ts. What is a WorkflowDeclaration? The four artifact formats (managed-agent .md, workflow .yaml, dynamic-workflow .js, dashboard .md) and how each compiles into a common IR. What is "dynamic-workflow" / the Anthropic Workflow runtime integration?
- managed-agents/: compile-agent.ts, from-md.ts, resolve-harness.ts, types.ts. How a managed agent declaration maps to a runnable agent; callableAs/subagent; extends/composition.
- harness/: index.ts, types.ts, and subdirs cas/, cursor/, fragua-pi/, mock/. THIS IS CRITICAL: ernesto already abstracts multiple harnesses including "fragua-pi". Document the harness interface (types.ts), what each harness does, and EXACTLY how fragua-pi already integrates fragua/pi today — what it calls, what it expects back, streaming, tool surface, structured output.
- route/, route-results/: the route execution + result shaping.
- workdir/: per-run working directory / sandbox model.
- lint/: the settle-time lint gate.
- StructuredOutput: how structured output + retry/nudge counting works (grep for StructuredOutput, nudge, retry across these dirs).

Return structured output per the schema. Be especially precise about the harness interface and the existing fragua-pi adapter, since that is the seam fragua will plug into.`,
  },
  {
    label: 'map:ernesto-backend-runtime',
    prompt: `You are mapping ernesto's PRODUCTION runtime requirements (multi-tenancy, persistence, transports, scheduling, tiers) so another team replacing its engine with "fragua" knows the non-negotiable production constraints. Read under ${ROOT}/backend/src (especially backend/src/ernesto, routes/, mcp/, workers/, scripts/, sql-scripts/) and ${ROOT}/cli/src and ${ROOT}/admin-panel/src. Full TS repos; Read/Grep/Glob/Bash freely. Use grep to find where lib's workflow-engine is imported/wired.

Cover with file:line evidence:
- The PRODUCTION store: ernesto uses postgres tables fact_events + ernesto_runs (per the architecture plan). Find the store implementation that backs the workflow-engine store port in production (grep fact_events, ernesto_runs, the class implementing the store port). Postgres vs sqlite. Transactions, OCC, payload caps.
- Multi-tenancy & identity: the "principal" model (user vs service), scopes, per-principal scope narrowing (caller.scopes ∩ target.scope), workspace-scoped authorization. How scope_denied is enforced.
- Transports/callers: /v2/dispatch HTTP, /tier-c/execute, MCP execute() tool, Slack subscriber, scheduler/cron (trigger.cron). Find these in routes/ and mcp/.
- Tiers: the tier-event-bridge and Tier A/B/C rendering. How fact events are bridged to each tier. How the laptop CLI (cli/src) consumes events/execute.
- Scheduling: cron/scheduled dispatch.
- The _platform://task subagent dispatch + depth cap + outputFormat structured output.
- Anything in admin-panel/src that consumes runs (dashboards run-dashboard-block, run inspection).

Return structured output per the schema. The "constraints" array should capture the production must-haves (postgres-backed, multi-principal scopes, three tiers, HTTP+MCP+cron transports, embeddable as a Node.js library — NOT a standalone Bun daemon).`,
  },
  {
    label: 'map:fragua-surface',
    prompt: `You are mapping what the "fragua" engine EXPOSES as a consumable library today, and its coupling constraints, so we can tell the fragua team what to add for ernesto to embed it. Read under ${ROOT}/fragua (a Bun/TypeScript monorepo; Read/Grep/Glob/Bash freely). Read fragua/CLAUDE.md, fragua/docs/SPEC.md, fragua/docs/ARCHITECTURE.md, fragua/docs/handler-contract.md, then the packages.

Packages: packages/{types,store,core,daemon,agent,server,workspace,cli,web}. Dependency direction: web → server → store ← daemon → core ← agent.

Cover with file:line evidence — for EACH, classify as "exposed as importable library API" vs "CLI-only" vs "HTTP-only" vs "internal":
- @fragua/core: handler contract (src/handler/types.ts), engine reducers (src/engine/{edge-selection,substitution,retry-policy,thread}.ts), YAML parser (src/parser/yaml.ts), intent-plane (write surface), read-plane (read surface). Is core's main entry browser/node-safe? Which sub-entries are server-side only?
- @fragua/store: src/store.ts, schema.sql, reducers.ts. THE KEY COUPLING: it's bun:sqlite (WAL/STRICT/generated columns). Is the store interface abstracted behind an interface (IEventStore?) or hardcoded to bun:sqlite? Could it back onto postgres? Document the schema/event taxonomy.
- @fragua/daemon: executor, supervisor, auto-dispatcher, result-to-facts, recorder, worktree-provisioner. Is the executor embeddable (runOne) or only as a daemon fiber? fragua ci "embeds the executor" — how?
- @fragua/agent: PiLlmBackend, pi-ai/pi-agent-core bridge, system-prompt, tool-adapter. How tools/providers are wired. Structured output support.
- @fragua/workspace: ExecutionEnvironment adapters (worktree-env, local-env), tools, run-actions. The git-worktree execution model.
- @fragua/server: Hono HTTP+SSE — explicitly "for the Web UI". Is there a programmatic dispatch API, or only HTTP?
- @fragua/cli: is it a direct store-client (no HTTP)? Could ernesto call the same store-client/plane APIs programmatically?

CRITICAL coupling questions to answer explicitly in constraints: (1) Bun runtime + bun:sqlite vs Node.js — what blocks running fragua as a Node.js library? (2) Single-tenant cwd-based model vs multi-principal/scope. (3) Is there ANY scope/auth/multi-tenancy concept? (4) Pluggable persistence? (5) A programmatic embed API (dispatch a run from JS, get a handle, subscribe to events) vs CLI/daemon-only? (6) HITL, schedules, cost-control, retry-policy — exposed as library hooks? (7) Step kinds supported (llm, tool, group, foreach, input?) — what's missing vs ernesto's kinds.

Return structured output per the schema. Be brutally precise about what is and isn't a library-importable API today.`,
  },
]

const maps = await parallel(
  briefs.map((b) => () =>
    agent(b.prompt, { label: b.label, phase: 'Map', schema: MAP_SCHEMA })
  )
)

const validMaps = maps.filter(Boolean)
log(`Mapped ${validMaps.length}/4 surfaces`)

phase('Synthesize')

const SYNTH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['strategy', 'recommendations'],
  properties: {
    strategy: { type: 'string', description: 'overall narrative: how ernesto should embed fragua, what the seam is, biggest risks' },
    recommendations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'title', 'category', 'ernestoNeed', 'evidence', 'fraguaGap', 'recommendation', 'priority', 'effort'],
        properties: {
          id: { type: 'string', description: 'short stable id like R1, R2' },
          title: { type: 'string' },
          category: { type: 'string', description: 'e.g. embeddability, persistence, scope/multi-tenancy, dispatch-api, middleware/hooks, observability, cost, step-kinds, hitl, harness/tooling, structured-output' },
          ernestoNeed: { type: 'string' },
          evidence: { type: 'string', description: 'ernesto file:line refs proving the need' },
          fraguaGap: { type: 'string', description: 'what fragua exposes today / what is missing, with fragua file refs' },
          recommendation: { type: 'string', description: 'concrete ask: the API shape / config / hook fragua should expose' },
          priority: { type: 'string', enum: ['P0', 'P1', 'P2'] },
          effort: { type: 'string' },
        },
      },
    },
  },
}

const planContext = `CONTEXT — ernesto's own roadmap (agent-ops plan "substrate-to-platform.md"):
ernesto's engine = one dispatch primitive -> ordered middleware chain -> DAG walker -> fact event log -> per-tier renderers, backed by postgres (fact_events + ernesto_runs). Five platform gaps it wants to close: W1 observability (dispatch-stats sink over the fact stream), W2 fast authoring loop (dry-run/no-settle/replay), W3 quality signals (StructuredOutput retry-count -> low-confidence, regression cohorts), W4 cost guardrails (pre-flight per-workspace budget envelope + cost-guard middleware before model-router), W5 artifact unification (one frontmatter, kind-tagged body across managed-agent/workflow/dynamic-workflow/dashboard). Small wins: kind:'foreach' runtime-N fan-out inside the engine's persistence/scope/HITL envelope; fact.workflow_phase_* events; workflow extends:; _platform://lint-workspace route. Multi-principal scopes (caller.scopes ∩ target.scope), three tiers (A backend / B claude.ai / C laptop CLI), HITL only for USER principals, depth-2 subagent cap.`

const synthesis = await agent(
  `You are the lead architect deciding what the fragua team must expose so ernesto can replace its in-house workflow engine (lib/src/workflow-engine) with fragua. fragua will SWITCH FROM A BUN DAEMON TO A NODE.JS LIBRARY to accommodate ernesto best — so "make it embeddable as a Node lib" asks are in scope and expected.

You have four structured maps below: (1) ernesto engine internals & middleware, (2) ernesto artifact/harness model + existing fragua-pi adapter, (3) ernesto production runtime constraints, (4) fragua's exposed library surface & couplings.

${planContext}

Produce a SHARP, deduplicated list of recommendations: concrete things ernesto NEEDS that fragua does NOT expose today. For each: the ernesto need (with file:line evidence), the precise fragua gap (with fragua file refs), and a CONCRETE recommendation — the actual API/config/hook shape fragua should expose (function signatures, interface names, config knobs). Prioritize P0 (blocks embedding at all: Node runtime, pluggable postgres store, programmatic dispatch+event API, multi-principal scope/auth) / P1 (needed for parity: middleware/hook chain, step kinds incl foreach, structured-output retry signal, cost pre-flight, HITL for service vs user principals, tier event bridging) / P2 (nice-to-have / aligns with their roadmap). Also write a 'strategy' narrative: where the seam is (does ernesto keep its dispatch/middleware/scope shell and use fragua only as the DAG-walker+store+agent core? or adopt fragua wholesale?), the single biggest risk, and what the fragua-pi harness already proves works.

Be specific and engineering-grade — this list goes straight to the fragua team. Avoid vague asks like 'better observability'; say exactly which event/field/hook.

=== MAP 1: ERNESTO ENGINE ===
${JSON.stringify(validMaps.find(m => m.area?.toLowerCase().includes('engine') || m.area?.toLowerCase().includes('middleware')) || validMaps[0], null, 1)}

=== MAP 2: ERNESTO ARTIFACTS & HARNESS ===
${JSON.stringify(validMaps.find(m => m.area?.toLowerCase().includes('harness') || m.area?.toLowerCase().includes('artifact')) || validMaps[1], null, 1)}

=== MAP 3: ERNESTO PRODUCTION RUNTIME ===
${JSON.stringify(validMaps.find(m => m.area?.toLowerCase().includes('runtime') || m.area?.toLowerCase().includes('production') || m.area?.toLowerCase().includes('backend')) || validMaps[2], null, 1)}

=== MAP 4: FRAGUA SURFACE ===
${JSON.stringify(validMaps.find(m => m.area?.toLowerCase().includes('fragua')) || validMaps[3], null, 1)}`,
  { label: 'synthesize:gap', phase: 'Synthesize', schema: SYNTH_SCHEMA }
)

phase('Verify')

const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'gapIsReal', 'confidence', 'finding'],
  properties: {
    id: { type: 'string' },
    gapIsReal: { type: 'boolean', description: 'true if fragua genuinely lacks this; false if fragua already exposes it (then the rec is wrong/needs reframing)' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    finding: { type: 'string', description: 'what fragua actually exposes for this, with fragua file:line evidence; if gap is real, confirm nothing covers it' },
  },
}

const recs = synthesis?.recommendations || []
const verdicts = await parallel(
  recs.map((r) => () =>
    agent(
      `Adversarially verify ONE claimed gap before we hand it to the fragua team. The claim is that fragua does NOT expose something ernesto needs. Your job: try to REFUTE it by finding that fragua already exposes it (possibly under a different name). Read fragua code under ${ROOT}/fragua (packages/{core,store,daemon,agent,server,workspace,cli,types}, docs/). Default to gapIsReal=true ONLY if you genuinely cannot find fragua covering it after searching.

CLAIM ID: ${r.id}
TITLE: ${r.title}
CATEGORY: ${r.category}
ERNESTO NEED: ${r.ernestoNeed}
ALLEGED FRAGUA GAP: ${r.fraguaGap}
RECOMMENDATION: ${r.recommendation}

Search fragua thoroughly (grep for related symbols, read the relevant package). Report whether the gap is real, your confidence, and exactly what fragua does/doesn't expose with file:line evidence.`,
      { label: `verify:${r.id}`, phase: 'Verify', schema: VERIFY_SCHEMA }
    )
  )
)

const byId = {}
for (const v of verdicts.filter(Boolean)) byId[v.id] = v

return {
  strategy: synthesis?.strategy || '(synthesis failed)',
  recommendations: recs.map((r) => ({ ...r, verification: byId[r.id] || null })),
}
