/**
 * Skill Registry
 *
 * Central registry for skills. Replaces DomainRegistry for the skill-based API.
 * Provides dashboard serialization via toJSON().
 */

import { Skill, SkillTool } from './skill';
import debug from 'debug';

const log = debug('ernesto:skill-registry');

/**
 * Serializable skill snapshot for dashboard
 */
export interface SkillSnapshot {
    name: string;
    slug: string;
    version?: string;
    description: string;
    toolCount: number;
    tools: { name: string; description: string; freshness?: string }[];
    resourceCount: number;
    requiredScopes?: string[];
    triggers?: string[];
    icon?: string;
    tags?: string[];
    enabled: boolean;
}

/**
 * Flat tool reference with skill context
 */
export interface ToolRef {
    /** Full identifier: "skill:tool" */
    id: string;
    /** Skill name */
    skill: string;
    /** Tool instance */
    tool: SkillTool;
}

export class SkillRegistry {
    protected skills = new Map<string, Skill>();

    /**
     * Register a skill
     */
    register(skill: Skill): void {
        if (this.skills.has(skill.name)) {
            log('Overwriting existing skill', { skill: skill.name });
        }
        this.skills.set(skill.name, skill);
        log('Registered skill', { skill: skill.name, tools: skill.tools.length });
    }

    /**
     * Register multiple skills
     */
    registerAll(skills: Skill[]): void {
        for (const skill of skills) {
            this.register(skill);
        }
    }

    /**
     * Get skill by name
     */
    get(name: string): Skill | undefined {
        return this.skills.get(name);
    }

    /**
     * Get all registered skills
     */
    getAll(): Skill[] {
        return Array.from(this.skills.values());
    }

    /**
     * Check if skill exists
     */
    has(name: string): boolean {
        return this.skills.has(name);
    }

    /**
     * Get flat map of all tools across all skills
     */
    getAllTools(): ToolRef[] {
        const refs: ToolRef[] = [];
        for (const skill of this.skills.values()) {
            for (const tool of skill.tools) {
                refs.push({
                    id: `${skill.name}:${tool.name}`,
                    skill: skill.name,
                    tool,
                });
            }
        }
        return refs;
    }

    /**
     * Resolve a tool by "skill:tool" identifier
     */
    resolveTool(identifier: string): ToolRef | undefined {
        const colonIdx = identifier.indexOf(':');
        if (colonIdx === -1) return undefined;

        const skillName = identifier.substring(0, colonIdx);
        const toolName = identifier.substring(colonIdx + 1);

        const skill = this.skills.get(skillName);
        if (!skill) return undefined;

        const tool = skill.tools.find((t) => t.name === toolName);
        if (!tool) return undefined;

        return { id: identifier, skill: skillName, tool };
    }

    /**
     * Remove a skill by name
     */
    remove(name: string): boolean {
        return this.skills.delete(name);
    }

    /**
     * Serialize all skills for dashboard
     */
    toJSON(): SkillSnapshot[] {
        return this.getAll().map((skill) => ({
            name: skill.name,
            slug: skill.slug,
            version: skill.version,
            description: skill.description,
            toolCount: skill.tools.length,
            tools: skill.tools.map((t) => ({
                name: t.name,
                description: t.description,
                freshness: t.freshness,
            })),
            resourceCount: skill.resources?.length ?? 0,
            requiredScopes: skill.requiredScopes,
            triggers: skill.triggers,
            icon: skill.icon,
            tags: skill.tags,
            enabled: skill.enabled ?? true,
        }));
    }
}
