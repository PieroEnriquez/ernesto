/**
 * Workspace Format Utilities
 *
 * Converts in-memory Skill objects to workspace files:
 * - WORKSPACE.md — instruction document with tool reference
 * - TOOLS.json — portable tool metadata for agent discovery
 * - tools/*.sh — bash scripts for tool execution
 *
 * These utilities are used by deployers to bootstrap workspace branches
 * from skill definitions. The workspace IS the skill — readable by agents,
 * editable by teams, versioned in git.
 */

import { Skill, SkillTool } from './skill';
import { z } from 'zod';

// ─── WORKSPACE.md ──────────────────────────────────────────────────────────

/**
 * Generate WORKSPACE.md content from a skill definition.
 * This is the "skill document" that agents read to understand a domain.
 */
export function skillToWorkspaceMd(skill: Skill): string {
    const parts: string[] = [];

    parts.push(`# ${skill.name}`);
    parts.push('');

    if (skill.description) {
        parts.push(skill.description);
        parts.push('');
    }

    const instruction = typeof skill.instruction === 'string'
        ? skill.instruction
        : '<!-- Dynamic instruction — generated at runtime -->';
    parts.push(instruction);
    parts.push('');

    if (skill.tools.length > 0) {
        parts.push('## Tools');
        parts.push('');
        parts.push(`This workspace has **${skill.tools.length} tools**.`);
        parts.push(`Call them with \`run("${skill.slug}", "{tool}", {params})\`.`);
        parts.push('');
        for (const tool of skill.tools) {
            const sig = formatCompactSignature(tool.inputSchema);
            parts.push(`- **${tool.name}**${sig} — ${tool.description}`);
        }
        parts.push('');
    }

    return parts.join('\n');
}

// ─── TOOLS.json ────────────────────────────────────────────────────────────

export interface ToolsManifest {
    skill: string;
    description: string;
    tools: ToolManifestEntry[];
    generatedAt: string;
}

export interface ToolManifestEntry {
    name: string;
    description: string;
    freshness?: string;
    parameters?: ToolManifestParam[];
}

export interface ToolManifestParam {
    name: string;
    type: string;
    required: boolean;
    description?: string;
    enum?: string[];
    default?: unknown;
}

/**
 * Generate TOOLS.json content from a skill definition.
 * Portable tool metadata for agent discovery — not for execution.
 * Tool execution always goes through the TypeScript skill registry.
 */
export function skillToToolsJson(skill: Skill): ToolsManifest {
    return {
        skill: skill.slug,
        description: skill.description,
        tools: skill.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            ...(tool.freshness && { freshness: tool.freshness }),
            ...(tool.inputSchema && { parameters: schemaToParams(tool.inputSchema) }),
        })),
        generatedAt: new Date().toISOString(),
    };
}

// ─── Tool Scripts ──────────────────────────────────────────────────────────

/**
 * Generate a bash script for a tool.
 * The script calls the Ernesto HTTP API via curl.
 *
 * Environment variables:
 * - ERNESTO_URL (default: http://localhost:3002)
 * - ERNESTO_TOKEN (required for auth)
 *
 * Usage: ./check-errors.sh '{"cadence":"1h"}'
 * No args: prints parameter docs from script comments.
 */
export function generateToolScript(skillSlug: string, tool: { name: string; description: string }): string {
    return `#!/usr/bin/env bash
# ${tool.name} — ${skillSlug}
# ${tool.description}
#
# Run with no args to see parameter docs.
#
set -euo pipefail
ERNESTO_URL="\${ERNESTO_URL:-http://localhost:3002}"
PARAMS="\${1:-}"
[ -z "\$PARAMS" ] && { sed -n '/^#[^!]/p' "\$0"; exit 0; }
curl -sf \\
  -H "Authorization: Bearer \${ERNESTO_TOKEN}" \\
  -H "Content-Type: application/json" \\
  -X POST -d "\$PARAMS" \\
  "\$ERNESTO_URL/ernesto/http/tools/${skillSlug}/${tool.name}" | jq .
`;
}

/**
 * Generate all tool scripts for a skill.
 * Returns a map of filename → script content.
 */
export function generateAllToolScripts(skill: Skill): Map<string, string> {
    const scripts = new Map<string, string>();
    for (const tool of skill.tools) {
        scripts.set(`${tool.name}.sh`, generateToolScript(skill.slug, tool));
    }
    return scripts;
}

// ─── Private: Compact signature ────────────────────────────────────────────

/**
 * Format Zod schema as compact function-call signature.
 * e.g., (query, timeframe?: "1h"|"24h"|"7d")
 */
function formatCompactSignature(schema: z.ZodSchema | undefined): string {
    if (!schema || !(schema instanceof z.ZodObject)) return '';
    const shape = (schema as z.ZodObject<any>).shape;
    if (!shape) return '';
    const keys = Object.keys(shape);
    if (keys.length === 0) return '';
    const params = keys.map(key => formatParam(key, shape[key]));
    return `(${params.join(', ')})`;
}

function formatParam(name: string, schema: z.ZodSchema): string {
    let base: any = schema;
    let isOptional = false;
    let defaultVal: unknown;

    if (base instanceof z.ZodOptional) {
        isOptional = true;
        base = base._def.innerType;
    }
    if (base instanceof z.ZodDefault) {
        isOptional = true;
        const dv = base._def.defaultValue;
        defaultVal = typeof dv === 'function' ? dv() : dv;
        base = base._def.innerType;
    }

    if (base instanceof z.ZodEnum) {
        const entries = base._def.entries;
        const list = Array.isArray(entries) ? entries : Object.values(entries);
        return `${name}${isOptional ? '?' : ''}: ${list.map((v: unknown) => `"${v}"`).join('|')}`;
    }

    if (isOptional && defaultVal !== undefined) {
        return `${name}?: ${JSON.stringify(defaultVal)}`;
    }

    return `${name}${isOptional ? '?' : ''}`;
}

// ─── Private: Zod → TOOLS.json params ──────────────────────────────────────

function schemaToParams(schema: z.ZodSchema): ToolManifestParam[] {
    if (!(schema instanceof z.ZodObject)) return [];
    const shape = (schema as z.ZodObject<any>).shape;
    if (!shape) return [];

    return Object.keys(shape).map(name => {
        let base: any = shape[name];
        let required = true;
        let defaultValue: unknown;
        let description: string | undefined;

        description = base._def?.description;

        if (base instanceof z.ZodOptional) {
            required = false;
            base = base._def.innerType;
        }
        if (base instanceof z.ZodDefault) {
            required = false;
            const dv = base._def.defaultValue;
            defaultValue = typeof dv === 'function' ? dv() : dv;
            base = base._def.innerType;
        }

        let type = 'string';
        let enumValues: string[] | undefined;

        if (base instanceof z.ZodString) type = 'string';
        else if (base instanceof z.ZodNumber) type = 'number';
        else if (base instanceof z.ZodBoolean) type = 'boolean';
        else if (base instanceof z.ZodEnum) {
            type = 'enum';
            const entries = base._def.entries;
            enumValues = Array.isArray(entries) ? entries : Object.values(entries);
        } else if (base instanceof z.ZodArray) type = 'array';
        else if (base instanceof z.ZodObject) type = 'object';

        return {
            name,
            type,
            required,
            ...(description && { description }),
            ...(enumValues && { enum: enumValues }),
            ...(defaultValue !== undefined && { default: defaultValue }),
        };
    });
}
