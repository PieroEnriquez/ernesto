/**
 * Principal — the typed identity attached to every dispatch.
 *
 * Today the runner's `DispatchWorkflowInput.principal` is the bare shape
 * `{ userId, scopes }`. That conflates two genuinely different identity
 * classes:
 *
 *   - **user principals** — a real Bitrefill user invoking a workflow
 *     from a tier port (Slack thread, claude.ai conversation, Tier-C CLI,
 *     HTTP request after auth). Has a `userId`, a non-empty scope set,
 *     can HITL, gets rendered events, billing attributed to the user.
 *
 *   - **service principals** — a backend worker invoking a workflow
 *     headlessly (BullMQ job, cron tick, internal sync code). Has a
 *     `workerId` + correlation `requestId`, an empty scope set (bypasses
 *     scope check via the service allowlist), no HITL, no tier-port
 *     rendering, billing attributed to the worker.
 *
 * Treating them as a typed union sharpens every middleware in the
 * dispatch chain (scope-check, HITL availability, session continuity,
 * cost attribution). Replaces the synthetic-RouteContext-per-call-site
 * pattern from product-autofill's `runWorkflowOnce`.
 *
 * The user variant carries scopes as a ReadonlySet for §7.4 narrowing
 * by recursive dispatch (subworkflow / `_platform://task`).
 *
 * See workspaces/agent-ops/unified-runtime/architecture.md.
 */

export type Principal =
    | UserPrincipal
    | ServicePrincipal;

export interface UserPrincipal {
    readonly kind: 'user';
    readonly userId: string;
    readonly scopes: ReadonlySet<string>;
    readonly email?: string;
}

export interface ServicePrincipal {
    readonly kind: 'service';
    /** Stable identifier of the calling worker (e.g. 'autofill-worker',
     *  'extraction-scheduler', 'cron-tick-handler'). Used for billing
     *  attribution and the service allowlist in the scope-check
     *  middleware. */
    readonly workerId: string;
    /** Per-invocation correlation id — lets logs/events tie back to
     *  the upstream cause (BullMQ job id, cron tick id, etc.). */
    readonly requestId: string;
}

/** Construct a user principal — convenience over an inline literal so
 *  callers don't accidentally drop the `kind: 'user'` discriminator. */
export function userPrincipal(
    userId: string,
    scopes: Iterable<string>,
    email?: string,
): UserPrincipal {
    return {
        kind: 'user',
        userId,
        scopes: new Set(scopes),
        ...(email !== undefined ? { email } : {}),
    };
}

/** Construct a service principal — empty scope set is intentional;
 *  the scope-check middleware consults the service allowlist for
 *  bypass authority. */
export function servicePrincipal(
    workerId: string,
    requestId: string,
): ServicePrincipal {
    return { kind: 'service', workerId, requestId };
}

/** True when the principal can hold scopes (only user principals). */
export function isUserPrincipal(p: Principal): p is UserPrincipal {
    return p.kind === 'user';
}

/** True when the principal is a service identity (no scopes, no HITL). */
export function isServicePrincipal(p: Principal): p is ServicePrincipal {
    return p.kind === 'service';
}

/** §7.4 scope narrowing — for a recursive dispatch (subworkflow,
 *  managed-agent subagent), the child runs with the intersection of
 *  the parent's scopes and the called declaration's required scopes.
 *
 *  Service principals pass through unchanged — their authorization
 *  model is the allowlist, not scope set membership.
 *
 *  When the declared scope set is empty, the parent's scopes flow
 *  through (a kind that declares no scope inherits the caller's). */
export function narrowPrincipalScopes(
    parent: Principal,
    declaredScopes: Iterable<string>,
): Principal {
    if (parent.kind === 'service') return parent;
    const declared = new Set(declaredScopes);
    if (declared.size === 0) return parent;
    const narrowed = new Set<string>();
    for (const s of parent.scopes) {
        if (declared.has(s)) narrowed.add(s);
    }
    return {
        kind: 'user',
        userId: parent.userId,
        scopes: narrowed,
        ...(parent.email !== undefined ? { email: parent.email } : {}),
    };
}

/** Stable string identity for logs / event attribution / billing.
 *  `user:<userId>` for users, `service:<workerId>:<requestId>` for
 *  services. The format is deliberately greppable. */
export function principalIdentity(p: Principal): string {
    return p.kind === 'user'
        ? `user:${p.userId}`
        : `service:${p.workerId}:${p.requestId}`;
}
