/**
 * `route` step kind handler — invoked by the walker when a workflow
 * step has `kind: 'route'`. Looks up the route via the runner's
 * KindRegistry (post-bridge from backend route registries), then
 * invokes the route handler via `dispatchResolvedRoute` (the
 * registry-free variant of `dispatchRoute`).
 *
 * Lives in the lib (not the backend) so the workflow runner stays
 * self-contained: registering the `route` step kind doesn't require
 * the caller to pre-bind a RouteRegistry singleton. The kind registry
 * is the single source of truth for "which routes exist."
 *
 * Backend boot wires it via:
 *
 *   runner.registerStepKind('route', makeRouteStepHandler({
 *       kindRegistry: runner.kindRegistry,
 *       log,
 *   }));
 */

import type { RouteStep } from '../../workflows/types';
import type { StepKindHandler, EngineLogger, EmitFactEvent } from '../types/handler';
import type { UiComponent } from '../../components/types';
import type { KindRegistry } from '../kind-registry';
import { dispatchResolvedRoute } from '../../route/dispatch';
import type { RouteContext } from '../../route/define-route';

export interface RouteStepHandlerDeps {
    kindRegistry: KindRegistry;
    log: EngineLogger;
}

/** Caller-fault tags route handlers throw (`Error('<tag>: <detail>')`).
 *  Must stay in sync with the backend wire classifier
 *  (`agent-api/tagged-error.ts` TAG_RE). Deliberately excludes
 *  `not_implemented:` and untagged throws — those are server faults whose
 *  raw text must not ride the wire. */
const CALLER_FAULT_TAG_RE = /^(scope_denied|invalid_input|not_found): /;

export function makeRouteStepHandler(deps: RouteStepHandlerDeps): StepKindHandler<RouteStep> {
    return async (step, ctx) => {
        const decl = deps.kindRegistry.resolve(step.uri);
        if (!decl) {
            return {
                kind: 'error',
                code: 'uri_not_found',
                message: `${step.uri} not registered in kind registry`,
            };
        }

        // Non-route kinds (workflow, future kinds) — recursive dispatch
        // through the runner. The step's `uri` resolves to a registered
        // declaration that isn't a route; `ctx.dispatch` is the pre-bound
        // closure the walker installed (inherits principal + routing).
        // This is what makes `kind: route` work as "dispatch by URI" —
        // the original route-only restriction was the artifact of an
        // earlier separate `kind: subworkflow` that has since been
        // unified away.
        if (decl.kind !== 'route') {
            if (!ctx.dispatch) {
                return {
                    kind: 'error',
                    code: 'no_recursive_dispatch',
                    message: `${step.uri} resolves to ${decl.kind} but ctx.dispatch is unavailable`,
                };
            }
            const child = await ctx.dispatch(step.uri, step.params ?? {});
            if (child.status === 'completed') {
                return { kind: 'completed', output: child.output ?? {} };
            }
            if (child.status === 'errored') {
                return {
                    kind: 'error',
                    code: child.error?.code ?? 'child_workflow_errored',
                    message: child.error?.message ?? `child workflow ${step.uri} errored`,
                };
            }
            return {
                kind: 'error',
                code: 'child_workflow_unfinished',
                message: `child workflow ${step.uri} returned status=${child.status}`,
            };
        }

        if (ctx.principal.kind !== 'user') {
            // Route handlers expect a user principal — `RouteContext.user`
            // carries the id (+ optional email). Service principals
            // route through workflows or worker harnesses, not direct
            // route dispatch.
            return {
                kind: 'error',
                code: 'missing_principal',
                message: 'route step requires a user principal',
            };
        }

        // RouteContext.workspaceView is REQUIRED (Wave 2): every route runs
        // with a bound overlay view, the physical workdir is its lazy
        // projection. The engine threads the view from the transport/composer
        // via `opts.context.workspaceView` → buildPreContext → here. If it is
        // missing the dispatch reached us without a bound view — a wiring bug,
        // not a caller fault. Surface it loudly rather than constructing a
        // view-less context (which the type now forbids).
        if (!ctx.workspaceView) {
            return {
                kind: 'error',
                code: 'no_workspace_view_bound',
                message: 'route step requires a bound workspace view',
            };
        }

        // Whether the route's OWN `render: [...]` manifest surfaces depends on
        // HOW the route was invoked — both paths land here, because a direct
        // `execute(route)` is dispatched as a runner-synthesized one-step route
        // workflow (see `runner.resolveKind`), the same handler an authored
        // workflow route step uses.
        //   - DIRECT dispatch (`step.surfaceRender`): the route IS the answer,
        //     so wire `emitComponent` and let its manifest render (the daily
        //     fraud report, revenue breakdown, etc.).
        //   - AUTHORED workflow step (no flag): the route's output is
        //     intermediate data — it feeds downstream steps, seeds a HITL
        //     prompt, or rolls up into workflow outputs — so its manifest stays
        //     PRIVATE (otherwise the raw warehouse report dumps above a
        //     Create-CMT-Case HITL). Only an author-declared STEP-level
        //     `step.render` surfaces, via `projectStepOutput` below.
        const emit: EmitFactEvent | undefined = ctx.emit;
        const emitComponent: RouteContext['emitComponent'] =
            step.surfaceRender && emit
                ? (c): void => {
                      emit({ type: 'fact.component', component: c as unknown as UiComponent });
                  }
                : undefined;

        const routeCtx: RouteContext = {
            user: ctx.principal.email ? { id: ctx.principal.userId, email: ctx.principal.email } : { id: ctx.principal.userId },
            scopes: ctx.principal.scopes,
            log: deps.log,
            workspaceView: ctx.workspaceView,
            // Thread the engine's run id into the route context so route
            // handlers can attest WHICH run invoked them (`RouteContext.runId`
            // existed but was never populated on this path — enrichment-cards'
            // `by.runId` reads it as the authoritative, engine-attested value).
            ...(ctx.runId ? { runId: ctx.runId } : {}),
            ...(ctx.workdirRoot ? { workdirRoot: ctx.workdirRoot } : {}),
            ...(emitComponent ? { emitComponent } : {}),
        };

        const result = await dispatchResolvedRoute(decl.route, step.params ?? {}, routeCtx);

        if (!result.ok) {
            // A handler throw reaches us as `handler_failed` with the thrown
            // message only in details — and run-graph's firstError keeps just
            // {stepId, code, message}. Promote TAGGED caller-fault messages
            // (`scope_denied: …`) so they survive to the run error and the
            // wire can classify them; untagged throws and other dispatch
            // errors keep the flattened `route … failed` form so raw server
            // fault text never rides `run.error.message` onto the wire.
            const detailMessage = (result.details as { message?: unknown } | undefined)?.message;
            const taggedMessage =
                result.error === 'handler_failed' && typeof detailMessage === 'string' && CALLER_FAULT_TAG_RE.test(detailMessage)
                    ? detailMessage
                    : undefined;
            return {
                kind: 'error',
                code: result.error,
                message: taggedMessage ?? `route ${step.uri} failed: ${result.error}`,
                details: result.details,
            };
        }

        // Step-level render manifest — attach to output so the
        // walker's `projectStepOutput` emits components from it.
        if (Array.isArray(step.render) && step.render.length > 0) {
            const data =
                result.data && typeof result.data === 'object' && !Array.isArray(result.data)
                    ? (result.data as Record<string, unknown>)
                    : { value: result.data };
            return {
                kind: 'completed',
                output: { ...data, render: step.render },
            };
        }
        return { kind: 'completed', output: result.data };
    };
}
