/**
 * Route dispatch.
 *
 * One body for all three tier-frontends (Tier A in-process, Tier B MCP, Tier C
 * HTTPS). Looks up by URI, gates on scope, Zod-validates input + output, runs
 * the handler, and shapes errors into a discriminated `DispatchResult`.
 *
 * Spec deviation: the full signature in §30 is
 * `dispatchRoute(workdir, uri, params) → RouteResult`, where the Workdir
 * carries the registry, principal, and scope. This scaffolding takes
 * `(registry, uri, params, ctx)` directly — Workdir does not yet expose a
 * `registry` field, and `Principal` does not yet exist on the lib. The
 * Workdir-bound signature lands when B.6 wires the backend; this module's
 * shape is the substrate.
 */

import type { RouteRegistry } from './route-registry';
import type { RouteContext, RouteScope } from './define-route';
import { resolveRouteScope } from './define-route';
import { archiveRouteResult } from '../route-results/archive';
import { compactify } from '../route-results/compactify';
import { sketchComponents } from './stage-sketch';
import { applyRenderManifest } from './render';

const AGENT_OPS_SCOPE: RouteScope = 'ernesto:agent-ops';

export type DispatchErrorCode =
    | 'route_not_found'
    | 'scope_denied'
    | 'invalid_input'
    | 'invalid_output'
    | 'handler_failed';

export type DispatchResult =
    | {
          ok: true;
          data: unknown;
          /** Compact preview of the full route response — set only when
           *  `ctx.archiveResults` is on AND `ctx.previewLimit !== 0`. */
          preview?: unknown;
          /** Workdir-relative path to the archived full route response.
           *  Set only when `ctx.archiveResults` is on (and archive succeeded). */
          file?: string;
      }
    | { ok: false; error: DispatchErrorCode; details?: unknown };

export async function dispatchRoute(
    registry: RouteRegistry,
    uri: string,
    params: unknown,
    ctx: RouteContext,
): Promise<DispatchResult> {
    const route = registry.get(uri);
    if (!route) {
        return { ok: false, error: 'route_not_found', details: { uri } };
    }

    // Validate input BEFORE resolving scope. Dynamic-scope routes
    // (e.g. `_platform://list-dashboards`, scope =
    // `${input.workspace}:read`) need typed input to compute their
    // required scope. For static-scope routes the ordering is
    // semantically identical: a malformed call returns `invalid_input`
    // either way; a well-formed but unauthorized call returns
    // `scope_denied`. Returning `invalid_input` before `scope_denied`
    // when both apply is also the safer disclosure — we don't leak
    // "your scope was wrong" until the caller has at least passed the
    // input contract.
    const parsedInput = route.input.safeParse(params);
    if (!parsedInput.success) {
        return {
            ok: false,
            error: 'invalid_input',
            details: { issues: parsedInput.error.issues },
        };
    }

    const requiredScope = resolveRouteScope(route, parsedInput.data);
    const scopeDenial = checkScope(requiredScope, ctx.scopes);
    if (scopeDenial) {
        return { ok: false, error: 'scope_denied', details: scopeDenial };
    }

    let raw: unknown;
    try {
        raw = await route.handler(parsedInput.data, ctx);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: 'handler_failed', details: { message } };
    }

    const parsedOutput = route.output.safeParse(raw);
    if (!parsedOutput.success) {
        ctx.log.error('Route returned output that failed schema validation', {
            uri: route.uri,
            issues: parsedOutput.error.issues,
        });
        return {
            ok: false,
            error: 'invalid_output',
            details: { issues: parsedOutput.error.issues },
        };
    }

    // Render manifest — opt-in per route. When the route declares
    // `render: [...]` AND the caller wired `ctx.emitComponent`, walk
    // the manifest, emit components, and **strip the typed data from
    // the response envelope**. The agent sees only `{ rendered, note }`
    // augmented with `preview` + `file` — it can answer follow-ups via
    // the archive without re-querying. Tests + non-agent dispatchers
    // (no `emitComponent` wired) keep getting full data.
    let strippedShape: Record<string, unknown> | undefined;
    if (route.render && route.render.length > 0 && ctx.emitComponent) {
        try {
            const components = applyRenderManifest(parsedOutput.data, route.render);
            for (const c of components) {
                try {
                    ctx.emitComponent(c);
                } catch (emitErr) {
                    ctx.log.warn('render manifest emit failed', {
                        uri: route.uri,
                        kind: c.kind,
                        errorMessage: (emitErr as Error).message,
                    });
                }
            }
            strippedShape = {
                rendered: components.map((c) => c.kind),
                staged: sketchComponents(components),
                note:
                    'These components are already rendered for the user ' +
                    "(per the renderer's own attach/preview policy — " +
                    'e.g. Slack converts large tables to CSV attachments ' +
                    'rendered inline). `staged` is a sketch of what was ' +
                    'shown (shape + small sample, NOT the full data). ' +
                    'The full data is in `file` (workdir-relative); `Read` ' +
                    'it on follow-up turns if you need specifics.\n' +
                    'Your hitl text is for what the user CANNOT see by ' +
                    'scanning the components: cross-tabs the data implies, ' +
                    'anomalies, concentration risks, comparisons across ' +
                    'dimensions the tables show separately, follow-up ' +
                    "questions the data triggers. NOT for restating " +
                    'numbers.\n' +
                    '  ❌ "US led at €X; UK €Y; Germany €Z" (reading the ' +
                    'region table aloud).\n' +
                    '  ❌ "Top payment method was user balance (€108K), ' +
                    'then BTC then ETH" (reading the method table aloud).\n' +
                    '  ✅ "Crypto rails (BTC+ETH+SOL+stablecoins) total ' +
                    '~37% of GMV at 5.1% margin vs 4.06% for user-balance ' +
                    '— stablecoins outperform fiat on margin per €."\n' +
                    '  ✅ "Apparel 8.15% margin and games 6.61% lead the ' +
                    'category mix — higher-margin growth levers vs the ' +
                    '4.61% blended."\n' +
                    'Aim for 2-3 insights, ≤4 sentences. If you find ' +
                    "yourself listing values, STOP and write the " +
                    'implication instead. ' +
                    'Do NOT add `data-ref` or `attachment` for this same ' +
                    '`file` — the renderer handles attachments. Call the ' +
                    'route again with modifiers in `params` if you need a ' +
                    'transform (sort/filter/group).',
            };
        } catch (walkErr) {
            ctx.log.warn('render manifest walk failed — returning full data', {
                uri: route.uri,
                errorMessage: (walkErr as Error).message,
            });
        }
    }

    // Archive + preview — only when the caller opts in (agent context).
    // Internal / test dispatchers leave `archiveResults` unset and keep
    // the legacy `{ data: <route-output> }` shape.
    if (ctx.archiveResults && ctx.workdirRoot) {
        const previewLimitRaw = ctx.previewLimit ?? 5;
        const inlineAll = previewLimitRaw === 'all';
        const previewLimit = inlineAll ? 0 : Math.max(0, Number(previewLimitRaw) || 0);
        const runId = ctx.runId ?? generateRunId();
        let file: string | undefined;
        try {
            file = await archiveRouteResult({
                workdir: ctx.workdirRoot,
                uri: route.uri,
                params: (parsedInput.data as Record<string, unknown>) ?? {},
                runId,
                data: parsedOutput.data,
                log: ctx.log,
            });
        } catch (err) {
            ctx.log.warn('archiveRouteResult failed — proceeding without file', {
                uri: route.uri,
                errorMessage: (err as Error).message,
            });
        }
        let preview: unknown;
        if (inlineAll) {
            // Caller asked for full inline data — no compactor.
            preview = parsedOutput.data;
        } else if (previewLimit > 0) {
            const custom = registry.getCompactor?.(route.uri);
            preview = custom
                ? custom(parsedOutput.data, previewLimit)
                : compactify(parsedOutput.data, previewLimit);
        }
        // The `data` slot keeps the unmodified route output (or the
        // strip envelope when the render manifest fired). `preview` +
        // `file` ride as sibling top-level fields on the dispatch
        // result, leaving the existing `{ ok, data }` contract intact
        // for legacy consumers that ignore the new fields.
        const result: DispatchResult = {
            ok: true,
            data: strippedShape ?? parsedOutput.data,
            ...(preview !== undefined ? { preview } : {}),
            ...(file !== undefined ? { file } : {}),
        };
        return result;
    }

    if (strippedShape) {
        return { ok: true, data: strippedShape };
    }
    return { ok: true, data: parsedOutput.data };
}

/** Synthetic run id when the caller didn't supply one. Short, sortable. */
function generateRunId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `r-${ts}-${rand}`;
}


interface ScopeDenialDetails {
    required: ReadonlyArray<RouteScope>;
    missing: ReadonlyArray<RouteScope>;
    missingCount: number;
}

function checkScope(
    required: ReadonlyArray<RouteScope>,
    scopes: ReadonlySet<RouteScope>,
): ScopeDenialDetails | null {
    if (scopes.has(AGENT_OPS_SCOPE)) return null;
    const missing = required.filter((s) => !scopes.has(s));
    if (missing.length === 0) return null;
    return {
        required,
        missing,
        missingCount: missing.length,
    };
}
