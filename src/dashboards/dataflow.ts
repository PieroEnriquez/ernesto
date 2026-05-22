/**
 * Dependency-order helper for the dashboard runtime.
 *
 * `dataflowOrder(spec)` returns the block ids in a stable topological
 * order — every block appears after every block it depends on. SQL
 * blocks have no incoming edges; JS blocks point at their declared
 * `inputs[]`. Cycles are caught at parse time (`crossCheck` in
 * `parse.ts`); this function assumes the graph is acyclic.
 *
 * The runtime walks blocks in this order when recomputing the page,
 * so a JS block downstream of multiple SQL blocks doesn't fire until
 * all of its inputs have resolved.
 */

import { isJsBlock, type DashboardSpec } from './schema';

export function dataflowOrder(spec: DashboardSpec): string[] {
    const visited = new Set<string>();
    const result: string[] = [];
    const byId = new Map(spec.blocks.map(b => [b.id, b]));

    const visit = (id: string): void => {
        if (visited.has(id)) return;
        visited.add(id);
        const block = byId.get(id);
        if (!block) return;
        if (isJsBlock(block)) {
            for (const upstream of block.inputs) visit(upstream);
        }
        result.push(id);
    };

    for (const block of spec.blocks) visit(block.id);
    return result;
}
