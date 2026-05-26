/**
 * `modelRouterMiddleware` — read `kind.policy.model` + `kind.policy.provider`
 * and project them onto the SDK env the harness will consume.
 *
 * Replaces the ad-hoc `resolveProviderEnv` pattern from
 * product-autofill's `workflows.ts`: instead of every WorkflowConfig
 * having `provider` + `model` fields and the runner stitching them
 * into SDK options, the kind declares both as policy and middleware
 * sets `ctx.annotations.providerEnv` for the agent step handler to
 * pick up.
 *
 * Bitrefill ships two providers today: ANTHROPIC (Claude models) and
 * OPEN_ROUTER (kimi-k2.6 + other open-source models). The middleware
 * resolves provider → API-key env var from the process env. Missing
 * env keys abort with `ModelRouterError` BEFORE the SDK is spun up,
 * so failures surface at dispatch time, not buried in a spawned
 * subprocess.
 */

import type { DispatchMiddleware, DispatchPreContext } from '../middleware';

export class ModelRouterError extends Error {
    readonly code = 'model_router_failed';
    constructor(message: string) {
        super(message);
        this.name = 'ModelRouterError';
    }
}

export interface ModelRouterOpts {
    /**
     * Per-provider env-var resolver. The middleware reads
     * `kind.policy.provider` and calls the matching resolver, which
     * returns the env vars the harness should inject when spawning
     * the SDK subprocess.
     *
     * Defaults map:
     *   ANTHROPIC → { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
     *   OPEN_ROUTER → { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
     *
     * Callers pass a custom resolver to add providers (e.g.
     * Bedrock, Vertex, Ollama).
     */
    providerEnv?: Record<
        string,
        (env: NodeJS.ProcessEnv) => Record<string, string>
    >;
}

const DEFAULT_RESOLVERS: NonNullable<ModelRouterOpts['providerEnv']> = {
    ANTHROPIC: (env) => {
        const key = env.ANTHROPIC_API_KEY;
        if (!key) {
            throw new ModelRouterError(
                'provider ANTHROPIC requires env ANTHROPIC_API_KEY',
            );
        }
        return { ANTHROPIC_API_KEY: key };
    },
    OPEN_ROUTER: (env) => {
        const key = env.OPENROUTER_API_KEY;
        if (!key) {
            throw new ModelRouterError(
                'provider OPEN_ROUTER requires env OPENROUTER_API_KEY',
            );
        }
        return {
            OPENROUTER_API_KEY: key,
            // The SDK reads ANTHROPIC_API_KEY by convention even when
            // routing to OpenRouter; mirror the key so the subprocess
            // doesn't fail the early auth check.
            ANTHROPIC_API_KEY: key,
        };
    },
};

export function modelRouterMiddleware(
    opts: ModelRouterOpts = {},
): DispatchMiddleware {
    const resolvers = { ...DEFAULT_RESOLVERS, ...(opts.providerEnv ?? {}) };

    return {
        name: 'model-router',
        before(ctx: DispatchPreContext): DispatchPreContext {
            const policy = ctx.decl?.policy;
            if (!policy?.provider && !policy?.model) return ctx;

            const provider = policy.provider ?? 'ANTHROPIC';
            const resolver = resolvers[provider];
            if (!resolver) {
                throw new ModelRouterError(
                    `unknown provider "${provider}" — register a resolver via modelRouterMiddleware({providerEnv})`,
                );
            }
            const providerEnv = resolver(process.env);

            // Stash on annotations — the agent step handler reads
            // `ctx.annotations.providerEnv` and merges into SDK env
            // before spawning.
            ctx.annotations.providerEnv = providerEnv;
            ctx.annotations.provider = provider;
            if (policy.model) ctx.annotations.model = policy.model;
            return ctx;
        },
    };
}
