/**
 * Compile a `DashboardSpec` into a `WorkflowDeclaration`.
 *
 * Per `workspaces/agent-ops/workflows-unification/dashboards-mapping.md`:
 *
 *   - filters         → workflow-level `inputs`
 *   - SQL blocks      → `route` step calling `redshift://query`
 *   - JS blocks       → `route` step calling `_platform://js_exec`
 *   - markdown blocks → `route` step calling `_platform://markdown`
 *   - dataflow deps   → `next:` chain (lexicographic tie-break for determinism)
 *   - cross-block `{{ revenue }}` refs in SQL → `${{ steps.revenue.output.* }}`
 *   - `format: chart|table|value|markdown` → `render:` annotation
 *
 * Determinism: same input → byte-identical output. The dataflow chain
 * follows `dataflowOrder()` from the dashboards module; when that
 * leaves ties (sibling blocks with no deps between them, e.g. two SQL
 * blocks), we break them lexicographically.
 */

import type { DashboardSpec, Block } from '../dashboards/schema';
import { dataflowOrder } from '../dashboards/dataflow';
import { isJsBlock, isSqlBlock } from '../dashboards/schema';
import type {
    WorkflowDeclaration,
    RouteStep,
    WorkflowInput,
    WorkflowOutput,
} from './types';

export function compileDashboardSpecToWorkflow(
    spec: DashboardSpec,
): WorkflowDeclaration {
    const orderedIds = stableDataflowOrder(spec);
    const blocksById = new Map(spec.blocks.map(b => [b.id, b]));

    // Pre-compute which blocks are "data" producers (their step output
    // can be referenced by later blocks). Markdown blocks render but
    // produce no consumable output.
    const dataBlockIds = new Set<string>();
    for (const b of spec.blocks) {
        if (b.kind !== 'markdown') dataBlockIds.add(b.id);
    }

    const steps: Record<string, RouteStep> = {};
    for (let i = 0; i < orderedIds.length; i++) {
        const id = orderedIds[i];
        const block = blocksById.get(id);
        if (!block) continue;
        const next = i + 1 < orderedIds.length
            ? orderedIds[i + 1]
            : 'outputs.blocks';
        steps[id] = compileBlock(block, next, dataBlockIds);
    }

    const inputs = compileInputs(spec);
    const outputs: Record<string, WorkflowOutput> = {
        blocks: {
            from: orderedIds.slice(),
            shape: 'dashboard',
        },
    };

    const workflow: WorkflowDeclaration = {
        name: spec.slug,
        description: spec.description ?? spec.title,
        version: 1,
        tags: ['dashboard'],
        owner: spec.owner,
        ...(inputs ? { inputs } : {}),
        steps: steps as Record<string, RouteStep>,
        outputs,
    };

    return workflow;
}

/**
 * Stable topological ordering: `dataflowOrder()` is deterministic on
 * a given graph, but its tie-breaks follow the declaration order of
 * `spec.blocks`. We want byte-stable output across declaration shuffles
 * — so we also sort sibling-at-same-rank ids lexicographically.
 *
 * The cheapest stable form that respects the partial order: re-run a
 * Kahn-style topological sort with a sorted ready set.
 */
function stableDataflowOrder(spec: DashboardSpec): string[] {
    const blocks = spec.blocks;
    const incoming = new Map<string, Set<string>>();
    const outgoing = new Map<string, string[]>();
    for (const b of blocks) {
        incoming.set(b.id, new Set());
        outgoing.set(b.id, []);
    }
    for (const b of blocks) {
        if (isJsBlock(b)) {
            for (const dep of b.inputs) {
                if (incoming.has(b.id)) incoming.get(b.id)!.add(dep);
                if (outgoing.has(dep)) outgoing.get(dep)!.push(b.id);
            }
        }
    }
    // Use dataflowOrder() as the authoritative DAG check; if its result
    // would diverge from ours, we'd be ignoring a cycle. We trust the
    // upstream invariant: parseDashboard rejected cycles already.
    void dataflowOrder(spec);

    const ready: string[] = [];
    for (const b of blocks) {
        if ((incoming.get(b.id)?.size ?? 0) === 0) ready.push(b.id);
    }
    ready.sort();
    const result: string[] = [];
    const remaining = new Map(incoming);
    while (ready.length > 0) {
        const next = ready.shift()!;
        result.push(next);
        for (const downstream of outgoing.get(next) ?? []) {
            const inc = remaining.get(downstream);
            if (!inc) continue;
            inc.delete(next);
            if (inc.size === 0) {
                // insert in sorted position
                insertSorted(ready, downstream);
            }
        }
    }
    return result;
}

function insertSorted(arr: string[], v: string): void {
    let lo = 0, hi = arr.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (arr[mid] < v) lo = mid + 1; else hi = mid;
    }
    arr.splice(lo, 0, v);
}

function compileBlock(
    block: Block,
    next: string,
    dataBlockIds: Set<string>,
): RouteStep {
    if (block.kind === 'markdown') {
        return {
            kind: 'route',
            uri: '_platform://markdown',
            params: { content: block.body },
            render: 'markdown',
            next,
        };
    }
    if (isSqlBlock(block)) {
        return {
            kind: 'route',
            uri: 'redshift://query',
            params: {
                template: rewriteCrossBlockRefs(block.sql, dataBlockIds),
            },
            render: renderForSqlBlock(block.kind),
            next,
        };
    }
    if (isJsBlock(block)) {
        return {
            kind: 'route',
            uri: '_platform://js_exec',
            params: {
                code: rewriteCrossBlockRefs(block.body, dataBlockIds),
                inputs: block.inputs.slice(),
            },
            render: renderForJsBlock(block.as),
            next,
        };
    }
    // Exhaustiveness — should never reach here under the schema.
    const exhaustive: never = block;
    return exhaustive;
}

function renderForSqlBlock(
    kind: 'metric-row' | 'timeseries' | 'table',
): 'chart' | 'table' | 'value' {
    if (kind === 'metric-row') return 'value';
    if (kind === 'timeseries') return 'chart';
    return 'table';
}

function renderForJsBlock(
    asKind: 'metric-row' | 'timeseries' | 'table',
): 'chart' | 'table' | 'value' {
    return renderForSqlBlock(asKind);
}

/**
 * Rewrite `{{ <blockId> }}` references inside SQL / JS bodies into the
 * canonical workflow form `${{ steps.<id>.output }}`. The dashboard
 * runtime today resolves these as opaque substitutions; the workflow
 * runtime threads them through the engine's `${{ }}` resolver.
 *
 * Only references to known data-producing block ids are rewritten;
 * other `{{ ... }}` (filter binds like `{{ binds.product }}`) become
 * `${{ inputs.product }}` via the secondary substitution.
 */
function rewriteCrossBlockRefs(body: string, dataBlockIds: Set<string>): string {
    let out = body;
    // First pass: rewrite `{{ <blockId> }}` → `${{ steps.<id>.output }}`.
    out = out.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (full, id: string) => {
        if (dataBlockIds.has(id)) {
            return `\${{ steps.${id}.output }}`;
        }
        return full;
    });
    // Second pass: rewrite `{{ binds.<name>.* }}` → `{{ inputs.<name>.* }}`.
    // These are filter-bind refs in the dashboard mental model; in the
    // workflow form, filters became workflow-level inputs.
    out = out.replace(/\{\{\s*binds\.([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (_full, path: string) => {
        return `{{ inputs.${path} }}`;
    });
    return out;
}

function compileInputs(
    spec: DashboardSpec,
): Record<string, WorkflowInput> | undefined {
    if (spec.filters.length === 0) return undefined;
    const out: Record<string, WorkflowInput> = {};
    for (const f of spec.filters) {
        out[f.id] = compileFilter(f);
    }
    return out;
}

function compileFilter(f: DashboardSpec['filters'][number]): WorkflowInput {
    switch (f.kind) {
        case 'date-range':
            return {
                type: 'date_range',
                default: { preset: f.default },
                ...(f.label !== undefined ? { description: f.label } : {}),
            };
        case 'multi-select':
            return {
                type: 'array',
                enum: f.options.slice(),
                ...(f.label !== undefined ? { description: f.label } : {}),
            };
        case 'single-select':
            return {
                type: 'string',
                enum: f.options.slice(),
                ...(f.default !== undefined ? { default: f.default } : {}),
                ...(f.label !== undefined ? { description: f.label } : {}),
            };
    }
}
