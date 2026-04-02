/**
 * Skill System - OpenClaw-compatible skill primitives
 *
 * Maps 1:1 to OpenClaw's SKILL.md format:
 * - Skill = SKILL.md directory (instruction + tools + resources)
 * - SkillTool = executable capability within a skill
 * - ToolResult = execution output (content + structured + suggestions)
 * - Suggestion = informational hint for next steps
 *
 * Skills are portable: export to SKILL.md → import in OpenClaw, and vice versa.
 */

import { z } from 'zod';
// eslint-disable-next-line import/no-cycle -- Type-only import, no runtime cycle
import type { Ernesto } from './Ernesto';
import type { Soul } from './soul';
import { PipelineConfig } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Context passed to skill tools during execution
 */
export interface ToolContext {
    user?: { id: string; email?: string };
    scopes?: string[];
    visibleSkills?: string[];
    soul?: Soul;
    requestId?: string;
    timestamp: number;
    ernesto: Ernesto;
    callStack?: string[];
}

/**
 * Context passed to dynamic skill instructions
 */
export interface SkillContext {
    user?: { id: string; email?: string };
    scopes?: string[];
    ernesto: Ernesto;
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL RESULT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Suggestion for next actions (informational, not gating)
 */
export interface Suggestion {
    /** Tool identifier: "skill:tool" */
    tool: string;
    /** Human-readable explanation of when/why to use this */
    prose: string;
    /** Optional pre-filled parameters */
    params?: Record<string, any>;
}

/**
 * Result from tool execution
 * Result from tool execution — content with optional structured output.
 */
export interface ToolResult {
    /** Markdown content for the agent */
    content: string;
    /** Optional structured output (replaces guidance-driven data) */
    structured?: unknown;
    /** Optional suggestions for next steps (informational, not gating) */
    suggestions?: Suggestion[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL TOOL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Data freshness indicator
 */
export type Freshness = 'live' | 'static' | 'unknown';

/**
 * A tool within a skill.
 *
 * Progressive workflow guidance belongs in instructions and suggestions,
 * not in visibility flags.
 */
export interface SkillTool<TInput = unknown> {
    /** Tool name within the skill (e.g., 'query', 'revenue-breakdown') */
    name: string;

    /** Human-readable description */
    description: string;

    /** Execute function — returns ToolResult */
    execute: (params: TInput, ctx: ToolContext) => Promise<ToolResult>;

    /** Zod input schema for validation */
    inputSchema?: z.ZodSchema<TInput>;

    /** Required permission scopes (in addition to skill-level scopes) */
    requiredScopes?: string[];

    /** Data freshness indicator */
    freshness?: Freshness;

    /** Static suggestion targets from defineSuggestions (auto-populated by createTool) */
    connections?: SuggestionTarget[];
}

// ═══════════════════════════════════════════════════════════════════════════
// SKILL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The Skill primitive — maps 1:1 to OpenClaw's SKILL.md directory.
 *
 * OpenClaw equivalence:
 * - skill.instruction → SKILL.md body
 * - skill.tools → executable capabilities
 * - skill.resources → indexed content (Typesense)
 * - skill.requiredScopes → OpenClaw requires.*
 * - skill.triggers → OpenClaw triggers field
 */
export interface Skill {
    /** Skill name (e.g., 'redshift', 'code', 'app-logs') */
    name: string;

    /** URL-safe slug (defaults to name if not provided) */
    slug: string;

    /** Skill version (semver) */
    version?: string;

    /** Short description for search/discovery */
    description: string;

    /**
     * Skill instruction — the "SKILL.md body"
     * Static string or dynamic function that generates instruction based on context.
     * Contains: teaching content, workflow guides, tool usage patterns.
     */
    instruction: string | ((ctx: SkillContext) => Promise<string>);

    /** Tools available in this skill */
    tools: SkillTool<any>[];

    /** Knowledge extractors (content sources for this skill) */
    resources?: PipelineConfig[];

    /** Required scopes — applied to all tools in this skill */
    requiredScopes?: string[];

    /** Activation triggers (OpenClaw-style) */
    triggers?: string[];

    /** Icon for dashboard display */
    icon?: string;

    /** Tags for categorization */
    tags?: string[];

    /** Whether this skill is enabled (default: true) */
    enabled?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// BUILDERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a skill with minimal boilerplate
 */
export function createSkill(config: {
    name: string;
    slug?: string;
    version?: string;
    description: string;
    instruction: string | ((ctx: SkillContext) => Promise<string>);
    tools: SkillTool<any>[];
    resources?: PipelineConfig[];
    requiredScopes?: string[];
    triggers?: string[];
    icon?: string;
    tags?: string[];
    enabled?: boolean;
}): Skill {
    return {
        name: config.name,
        slug: config.slug ?? config.name,
        description: config.description,
        instruction: config.instruction,
        tools: config.tools,
        ...(config.version !== undefined && { version: config.version }),
        ...(config.resources && { resources: config.resources }),
        ...(config.requiredScopes && { requiredScopes: config.requiredScopes }),
        ...(config.triggers && { triggers: config.triggers }),
        ...(config.icon !== undefined && { icon: config.icon }),
        ...(config.tags && { tags: config.tags }),
        ...(config.enabled !== undefined && { enabled: config.enabled }),
    };
}

/**
 * Create a tool result with just content (no suggestions)
 */
export function toolResult(content: string): ToolResult {
    return { content };
}

/**
 * Create a tool result with content and suggestions
 */
export function toolResultWithSuggestions(content: string, suggestions: Suggestion[]): ToolResult {
    return { content, suggestions };
}

// ═══════════════════════════════════════════════════════════════════════════
// SUGGESTION BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A suggestion rule — either always included or conditionally included.
 */
export type SuggestionRule<I, R> = {
    tool: string;
    prose: string | ((input: I, result: R) => string);
    params?: Record<string, any> | ((input: I, result: R) => Record<string, any>);
} & ({ always: true } | { when: (result: R) => boolean });

/**
 * Static target info extracted from suggestion rules
 */
export interface SuggestionTarget {
    tool: string;
    conditional: boolean;
}

/**
 * Compiled suggestion schema
 */
export interface SuggestionSchema<I, R> {
    resolve(input: I, result: R): Suggestion[];
    targets: SuggestionTarget[];
}

/**
 * Define suggestion rules for a tool.
 *
 * Each rule must specify either `always: true` or `when: fn`.
 * Rules are evaluated in definition order.
 */
export function defineSuggestions<I, R>(rules: Record<string, SuggestionRule<I, R>>): SuggestionSchema<I, R> {
    return {
        resolve(input: I, result: R): Suggestion[] {
            const output: Suggestion[] = [];

            for (const rule of Object.values(rules)) {
                const include = 'always' in rule || rule.when(result);

                if (include) {
                    output.push({
                        tool: rule.tool,
                        prose: typeof rule.prose === 'function' ? rule.prose(input, result) : rule.prose,
                        params: typeof rule.params === 'function' ? rule.params(input, result) : rule.params,
                    });
                }
            }

            return output;
        },
        targets: Object.values(rules).map(rule => ({
            tool: rule.tool,
            conditional: !('always' in rule),
        })),
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// TOOL BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for createTool()
 */
export interface ToolConfig<I, R = void> {
    name: string;
    description: string;
    inputSchema: z.ZodSchema<I>;
    suggestions?: SuggestionSchema<I, R>;
    execute: (params: I, ctx: ToolContext) => Promise<{ content: string; result?: R }>;
    requiredScopes?: string[];
    freshness?: Freshness;
}

/**
 * Create a tool with declarative suggestions.
 *
 * Execute returns { content, result }. Suggestions are resolved from result.
 */
export function createTool<I, R = void>(config: ToolConfig<I, R>): SkillTool<I> {
    return {
        name: config.name,
        description: config.description,
        inputSchema: config.inputSchema,
        requiredScopes: config.requiredScopes,
        freshness: config.freshness,
        connections: config.suggestions?.targets,

        async execute(params: I, ctx: ToolContext): Promise<ToolResult> {
            const { content, result } = await config.execute(params, ctx);

            const suggestions = config.suggestions && result !== undefined
                ? config.suggestions.resolve(params, result as R)
                : undefined;

            return {
                content,
                ...(suggestions?.length && { suggestions }),
            };
        },
    };
}
