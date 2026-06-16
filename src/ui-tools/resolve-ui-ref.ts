/**
 * `resolveUiRef` — reads a workdir-relative JSON file holding a UI
 * definition and returns the parsed `UiComponent[]` plus a
 * `jsonPathForIndex` helper the validator uses to attach JSON paths
 * to per-component errors.
 *
 * Defense layers, in order — identical to `upload-attachment.ts` so
 * the agent can't escape its workdir via the ref shape:
 *   1. `containsParentSegment(rawPath)` — reject any `..` segments
 *      before resolution.
 *   2. `isPathWithin(resolved, workdirRoot)` — lexical prefix check
 *      after resolution.
 *   3. Extension whitelist — `.json` only.
 *   4. Size cap (`MAX_REF_BYTES`) — agents shouldn't be passing
 *      multi-megabyte UI definitions, and we want to bound the read.
 *
 * File format:
 *
 *   { "component": <UiComponent | UiComponent[]> }
 *
 * The single-component shorthand mirrors the inline `mcp__ui__ui`
 * input. The wrapper object leaves room to grow (`{component,
 * settings}`, etc.) without a format break.
 */

import { promises as fs } from 'node:fs';
import { extname, join } from 'node:path';
import { containsParentSegment, isPathWithin, resolvePath } from '../path-security';

/** Max bytes we'll read off disk. Conservatively above a typical
 *  rich `hitl` (a few KB) but well below "agent dumped a JSON
 *  archive here by mistake" territory. */
export const MAX_REF_BYTES = 256 * 1024;

export type ResolveUiRefError =
    | 'ref_unsupported'
    | 'no_path'
    | 'path_traversal'
    | 'outside_workdir'
    | 'bad_extension'
    | 'not_found'
    | 'too_large'
    | 'read_failed'
    | 'invalid_json'
    | 'missing_component_field';

export type ResolveUiRefResult =
    | {
          ok: true;
          /** Coerced to an array even when the file had a single object
           *  under `component`. */
          components: unknown[];
          /** Number of leading list items unwrapped — `1` when the file
           *  had `{component: <obj>}`, otherwise the array length. Just
           *  a sanity-check value the caller may surface in diagnostics. */
          count: number;
          /** Build the JSON-path-ish identifier for the i-th component
           *  in the parsed `component` field. With a single-object
           *  shape it's `/component`, with an array it's
           *  `/component/<i>`. Used in error responses so the agent can
           *  jump straight to the right slice with `Read` / `Edit`. */
          jsonPathForIndex: (i: number) => string;
      }
    | {
          ok: false;
          error: ResolveUiRefError;
          /** Diagnostic message — surfaced verbatim in the tool result
           *  so the agent has a concrete recovery instruction. */
          message: string;
      };

export interface ResolveUiRefInput {
    /** Absolute path to the run's workdir root. Omitted in contexts
     *  that don't allocate one (tests, CLI ad-hoc dispatches) — the
     *  caller should fail with `ref_unsupported` in that case before
     *  reaching here. */
    workdirRoot: string;
    /** Raw `ref` value from the tool call (workdir-relative). */
    ref: string;
}

export async function resolveUiRef(input: ResolveUiRefInput): Promise<ResolveUiRefResult> {
    const { workdirRoot, ref } = input;
    if (!ref || ref.length === 0) {
        return {
            ok: false,
            error: 'no_path',
            message: 'ui ref is empty. Try: ref: "_ui/turn.json"',
        };
    }
    if (containsParentSegment(ref)) {
        return {
            ok: false,
            error: 'path_traversal',
            message:
                `ui ref "${ref}" contains a parent segment ("..") which is rejected. ` +
                'Refs must resolve inside the workdir; use a workdir-relative path like "_ui/turn.json".',
        };
    }
    if (extname(ref).toLowerCase() !== '.json') {
        return {
            ok: false,
            error: 'bad_extension',
            message:
                `ui ref "${ref}" must end in .json. ` +
                'The ref points to a JSON file containing { "component": <UiComponent | UiComponent[]> }.',
        };
    }
    const absolute = resolvePath(join(workdirRoot, ref));
    const allowed = resolvePath(workdirRoot);
    if (!isPathWithin(absolute, allowed)) {
        return {
            ok: false,
            error: 'outside_workdir',
            message: `ui ref "${ref}" resolves outside the workdir and is rejected. ` + 'Use a workdir-relative path.',
        };
    }
    let stats: { size: number };
    try {
        stats = await fs.stat(absolute);
    } catch {
        return {
            ok: false,
            error: 'not_found',
            message:
                `ui ref "${ref}" not found. Write the file first with the Write tool, ` + 'then call mcp__ui__ui again with the same ref.',
        };
    }
    if (stats.size > MAX_REF_BYTES) {
        return {
            ok: false,
            error: 'too_large',
            message:
                `ui ref "${ref}" is ${stats.size} bytes, over the ${MAX_REF_BYTES}-byte cap. ` +
                'Trim the file or split into multiple turns.',
        };
    }
    let raw: string;
    try {
        raw = await fs.readFile(absolute, 'utf8');
    } catch (err) {
        return {
            ok: false,
            error: 'read_failed',
            message: `ui ref read failed: ${(err as Error).message}`,
        };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return {
            ok: false,
            error: 'invalid_json',
            message:
                `ui ref "${ref}" is not valid JSON: ${(err as Error).message}. ` +
                'Top-level shape: { "component": <UiComponent | UiComponent[]> }.',
        };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {
            ok: false,
            error: 'missing_component_field',
            message:
                `ui ref "${ref}" must be a JSON object with a "component" field. ` +
                'Try: { "component": [{ "kind": "hitl", "props": { ... } }] }.',
        };
    }
    const componentField = (parsed as { component?: unknown }).component;
    if (componentField === undefined) {
        return {
            ok: false,
            error: 'missing_component_field',
            message: `ui ref "${ref}" has no "component" field. ` + 'Try: { "component": [{ "kind": "hitl", "props": { ... } }] }.',
        };
    }
    const isArray = Array.isArray(componentField);
    const components: unknown[] = isArray ? (componentField as unknown[]) : [componentField];
    return {
        ok: true,
        components,
        count: components.length,
        jsonPathForIndex: (i: number): string => (isArray ? `/component/${i}` : '/component'),
    };
}
