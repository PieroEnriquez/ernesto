/**
 * Route dispatch.
 *
 * One body for every transport (the in-process transport, the mcp transport,
 * the laptop transport). Looks up by URI, gates on scope, Zod-validates input
 * + output, runs the handler, and shapes errors into a discriminated
 * `DispatchResult`.
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
import type { Route } from './define-route';
import type { RouteContext, RouteScope } from './define-route';
import { resolveRouteScope } from './define-route';
import { sketchComponents } from './stage-sketch';
import { applyRenderManifest } from './render';
import { checkScope } from '../shared/scope';

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
          /** Compact preview of the full route response. Populated by the
           *  `execute` verb's archive+preview projection (`handleExecute`);
           *  the sync dispatch primitive itself never sets it. */
          preview?: unknown;
          /** Workdir-relative path to the archived full route response.
           *  Populated by the `execute` verb's archive+preview projection
           *  (`handleExecute`); the sync dispatch primitive never sets it. */
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
    return dispatchResolvedRoute(route, params, ctx);
}

/**
 * Registry-free dispatch: validate inputs + scope, run the handler,
 * validate outputs, apply the render manifest. Used by the workflow
 * runner's `route` step handler (which already resolved the route via
 * the kind registry) and as the body of `dispatchRoute` after its
 * lookup.
 *
 * Archive + preview projection (the agent-facing `preview` + `file`
 * fields) lives in the `execute` verb's `handleExecute`, not here — this
 * primitive stays focused on routing.
 */
export async function dispatchResolvedRoute(
    route: Route,
    params: unknown,
    ctx: RouteContext,
): Promise<DispatchResult> {
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

    if (strippedShape) {
        return { ok: true, data: strippedShape };
    }
    return { ok: true, data: parsedOutput.data };
}


