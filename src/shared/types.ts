/**
 * Cross-cutting lib types shared across the route, extraction, and
 * agent-verb surfaces.
 *
 * These were previously declared once per surface (`RouteLogger` /
 * `ExtractionLogger` / `VerbLogger`, and `RouteUser` / `ExtractionUser`
 * / `VerbUser`) with textually-identical bodies. They are unified here
 * so the contract has a single source of truth; the per-surface names
 * remain available as aliases where churn-avoidance warrants it.
 */

/**
 * Structured logger surface every dispatch path threads through its
 * context. Three levels; `meta` is an opaque structured payload the
 * concrete logger serializes however it likes.
 */
export interface Logger {
    info: (msg: string, meta?: unknown) => void;
    warn: (msg: string, meta?: unknown) => void;
    error: (msg: string, meta?: unknown) => void;
}

/**
 * The acting identity for a dispatch. Matches the shape used by
 * `ToolContext` (`skill.ts`) and `SessionUser` (`Session.ts`) —
 * `{ id, email? }`.
 */
export interface Principal {
    id: string;
    email?: string;
}
