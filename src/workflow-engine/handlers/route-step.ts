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
import type {
    StepKindHandler,
    EngineLogger,
    EmitFactEvent,
} from '../types/handler';
import type { UiComponent } from '../../components/types';
import type { KindRegistry } from '../kind-registry';
import { dispatchResolvedRoute } from '../../route/dispatch';
import type { RouteContext } from '../../route/define-route';

export interface RouteStepHandlerDeps {
    kindRegistry: KindRegistry;
    log: EngineLogger;
}

export function makeRouteStepHandler(
    deps: RouteStepHandlerDeps,
): StepKindHandler<RouteStep> {
    return async (step, ctx) => {
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
        const decl = deps.kindRegistry.resolve(step.uri);
        if (!decl || decl.kind !== 'route') {
            return {
                kind: 'error',
                code: 'route_not_found',
                message: `route ${step.uri} not registered in kind registry`,
            };
        }

        // Bridge route-level render manifests to the walker's step
        // emit channel. Routes that declare `render: [...]` project
        // `fact.component` events from inside workflow steps, same as
        // they do from agent-issued `execute(...)` tool calls.
        const emit: EmitFactEvent | undefined = ctx.emit;
        const emitComponent = emit
            ? (c: { kind: string; props: Record<string, unknown> }): void => {
                  emit({
                      type: 'fact.component',
                      component: c as unknown as UiComponent,
                  });
              }
            : undefined;

        const routeCtx: RouteContext = {
            user: ctx.principal.email
                ? { id: ctx.principal.userId, email: ctx.principal.email }
                : { id: ctx.principal.userId },
            scopes: ctx.principal.scopes,
            log: deps.log,
            ...(ctx.workdirRoot ? { workdirRoot: ctx.workdirRoot } : {}),
            ...(emitComponent ? { emitComponent } : {}),
        } as RouteContext;

        const result = await dispatchResolvedRoute(
            decl.route,
            step.params ?? {},
            routeCtx,
        );

        if (!result.ok) {
            return {
                kind: 'error',
                code: result.error,
                message: `route ${step.uri} failed: ${result.error}`,
                details: result.details,
            };
        }

        // Step-level render manifest — attach to output so the
        // walker's `projectStepOutput` emits components from it.
        if (Array.isArray(step.render) && step.render.length > 0) {
            const data =
                result.data &&
                typeof result.data === 'object' &&
                !Array.isArray(result.data)
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
