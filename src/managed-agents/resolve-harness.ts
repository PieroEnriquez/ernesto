/**
 * Resolve the concrete harness for an agent declaration / call site.
 *
 * Precedence (highest first):
 *   1. Explicit per-call `override` (e.g. `AgentStep.harness`)
 *   2. Explicit declaration `harness:` frontmatter
 *   3. Legacy `provider:` shorthand — `OPEN_ROUTER` → fragua-pi
 *   4. Default — `'cas'`
 *
 * Centralised so the lib, the wire-fragua agent handler, and any
 * future authoring tooling all agree on the same rule.
 */

import type { AgentDeclaration } from './types';

export type AgentHarness = 'cas' | 'cursor' | 'fragua-pi' | 'remote-vm';

export function resolveHarness(
    decl: Pick<AgentDeclaration, 'harness' | 'provider'> | undefined,
    override?: AgentHarness,
): AgentHarness {
    if (override) return override;
    if (decl?.harness) return decl.harness;
    if (decl?.provider === 'OPEN_ROUTER') return 'fragua-pi';
    return 'cas';
}
