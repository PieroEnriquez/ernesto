/**
 * Parse a `.dashboard.md` markdown blob into a typed `DashboardSpec` plus
 * the trailing body text.
 *
 * Failure modes — surfaced as thrown `DashboardSpecError`:
 *   - missing or malformed frontmatter
 *   - YAML that doesn't validate against `dashboardSpecSchema`
 *   - cross-checks:
 *     * block ids are unique
 *     * every `:bind` in any SQL block resolves to a filter bind or a
 *       reserved bind
 *     * every `inputs:` entry on a JS block references a known block id
 *     * the JS block dependency graph has no cycles
 */

import { load as yamlLoad } from 'js-yaml';
import { ZodError } from 'zod';
import {
    dashboardSpecSchema,
    type Block,
    type DashboardSpec,
    type ParsedDashboard,
    isSqlBlock,
    isJsBlock,
    isNarrativeBlock,
} from './schema';

export class DashboardSpecError extends Error {
    constructor(
        message: string,
        readonly details?: ReadonlyArray<string>,
    ) {
        super(message);
        this.name = 'DashboardSpecError';
    }
}

/** Reserved bind names the runtime always populates from a `date-range` filter. */
export const RESERVED_BIND_NAMES = new Set<string>([
    'startDate',
    'endDate',
    'startDateId',
    'endDateId',
    'dateGrain',
]);

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
const BIND_REFERENCE_RE = /(?<![:\w]):([a-zA-Z][a-zA-Z0-9_]*)/g;

export function parseDashboard(raw: string): ParsedDashboard {
    const match = FRONTMATTER_RE.exec(raw);
    if (!match) {
        throw new DashboardSpecError(
            'Missing YAML frontmatter — file must start with "---" and close with "---".',
        );
    }
    let yamlObj: unknown;
    try {
        yamlObj = yamlLoad(match[1]);
    } catch (e) {
        throw new DashboardSpecError(`Invalid YAML frontmatter: ${(e as Error).message}`);
    }

    let spec: DashboardSpec;
    try {
        spec = dashboardSpecSchema.parse(yamlObj);
    } catch (e) {
        if (e instanceof ZodError) {
            const details = e.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`);
            throw new DashboardSpecError('Spec schema validation failed.', details);
        }
        throw e;
    }

    crossCheck(spec);

    return { spec, body: match[2].trim() };
}

function crossCheck(spec: DashboardSpec): void {
    const errors: string[] = [];

    const blockIds = new Set<string>();
    for (const block of spec.blocks) {
        if (blockIds.has(block.id)) errors.push(`Duplicate block id: ${block.id}`);
        blockIds.add(block.id);
    }

    // Collect every bind name that a filter can produce.
    const knownBinds = new Set<string>(RESERVED_BIND_NAMES);
    for (const filter of spec.filters) {
        for (const bindRef of Object.values(filter.binds)) {
            const name = stripColon(bindRef);
            if (name) knownBinds.add(name);
        }
    }

    // Check every :bind appearing in an SQL block's SQL.
    for (const block of spec.blocks) {
        if (!isSqlBlock(block)) continue;
        const seen = new Set<string>();
        BIND_REFERENCE_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = BIND_REFERENCE_RE.exec(block.sql)) !== null) {
            seen.add(m[1]);
        }
        for (const bind of seen) {
            if (!knownBinds.has(bind)) {
                errors.push(`Block "${block.id}" references unknown :bind "${bind}"`);
            }
        }
    }

    // Check JS / narrative block inputs reference known data blocks.
    for (const block of spec.blocks) {
        if (!isJsBlock(block) && !isNarrativeBlock(block)) continue;
        for (const inputId of block.inputs) {
            if (inputId === block.id) {
                errors.push(`Block "${block.id}" lists itself as an input`);
                continue;
            }
            const ref = spec.blocks.find(b => b.id === inputId);
            if (!ref) {
                errors.push(`Block "${block.id}" inputs reference unknown block "${inputId}"`);
            } else if (ref.kind === 'markdown' || ref.kind === 'narrative') {
                errors.push(
                    `Block "${block.id}" inputs reference ${ref.kind} block "${inputId}" (only data blocks produce results)`,
                );
            }
        }
    }

    // Detect cycles in the JS-block dependency graph.
    const cycle = detectCycle(spec.blocks);
    if (cycle) {
        errors.push(`Dataflow cycle: ${cycle.join(' → ')}`);
    }

    if (errors.length > 0) {
        throw new DashboardSpecError('Spec cross-check failed.', errors);
    }
}

/**
 * Walk the JS block dependency graph (each js block's `inputs[]` points
 * to upstream blocks). Returns the first cycle found as a sequence of
 * block ids ending where it began, or `null` if the graph is acyclic.
 */
function detectCycle(blocks: ReadonlyArray<Block>): string[] | null {
    const adjacency = new Map<string, string[]>();
    for (const block of blocks) {
        if (isJsBlock(block)) adjacency.set(block.id, [...block.inputs]);
    }
    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    for (const id of adjacency.keys()) color.set(id, WHITE);

    const stack: string[] = [];
    const visit = (id: string): string[] | null => {
        const c = color.get(id) ?? BLACK;
        if (c === BLACK) return null;
        if (c === GRAY) {
            const idx = stack.indexOf(id);
            return idx >= 0 ? [...stack.slice(idx), id] : [id];
        }
        color.set(id, GRAY);
        stack.push(id);
        for (const next of adjacency.get(id) ?? []) {
            // Only follow edges into other js blocks (SQL terminals are leaves).
            if (!adjacency.has(next)) continue;
            const found = visit(next);
            if (found) return found;
        }
        stack.pop();
        color.set(id, BLACK);
        return null;
    };

    for (const id of adjacency.keys()) {
        const found = visit(id);
        if (found) return found;
    }
    return null;
}

function stripColon(bindRef: string): string | null {
    if (typeof bindRef !== 'string') return null;
    const trimmed = bindRef.trim();
    if (!trimmed.startsWith(':')) return null;
    const name = trimmed.slice(1);
    return /^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) ? name : null;
}
