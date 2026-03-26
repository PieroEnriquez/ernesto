// Library entry point

// ─── Core ────────────────────────────────────────────────────────────────
export { Ernesto } from './Ernesto';
export type { ErnestoSnapshot } from './Ernesto';

// ─── Skills (OpenClaw primitives) ────────────────────────────────────────
export { createSkill, createTool, defineSuggestions, toolResult, toolResultWithSuggestions } from './skill';
export type {
    Skill, SkillTool, ToolContext, SkillContext, ToolResult, Suggestion, Freshness,
    ToolConfig, SuggestionRule, SuggestionSchema, SuggestionTarget,
    DomainSearchConfig, SearchSegment,
} from './skill';
export { SkillRegistry } from './skill-registry';
// export { getVisibleSkills } from './skill-visibility'; // TODO: create file
export type { SkillSnapshot, ToolRef, SkillSourceInfo } from './skill-registry';
export { skillToMarkdown, skillFromMarkdown } from './skill-io';

// ─── Soul ────────────────────────────────────────────────────────────────
export { renderSoul } from './soul';
export type { Soul } from './soul';

// ─── Heartbeat ───────────────────────────────────────────────────────────
export type { HeartbeatConfig, TimeWindow } from './heartbeat';

// ─── System Prompt ───────────────────────────────────────────────────────
// export { SystemPromptBuilder, createDefaultPromptBuilder, buildSkillCatalog } from './system-prompt'; // TODO: create file
// export type { PromptContext, RenderedPromptSection } from './system-prompt';

// ─── Tools ───────────────────────────────────────────────────────────────
// export { createAskTool } from './tools/ask'; // TODO: create file
// export type { AskToolOptions } from './tools/ask';
// export { createRunTool } from './tools/run'; // TODO: create file

// ─── Instructions (legacy — use SystemPromptBuilder for new code) ────────
// export { InstructionRegistry } from './instructions/registry'; // TODO: create file
// export type { InstructionTemplate, InstructionContent, InstructionContext } from './instructions/types';

// ─── Pipelines ───────────────────────────────────────────────────────────
export { generateSourceId, ContentPipeline } from './pipelines';

// ─── Typesense ───────────────────────────────────────────────────────────
export { searchMcpResources, exportSourceDocuments, getSourceFreshness, getMcpResourceStats } from './typesense/client';
export type { McpResourceSearchResult } from './typesense/schema';

// ─── Types ───────────────────────────────────────────────────────────────
export { DEFAULT_CACHE_TTL_MS } from './types';
export type { ResourceNode, RawContent, ContentFormat, ContentSource, PipelineConfig, RawDocument } from './types';

// ─── Lifecycle ───────────────────────────────────────────────────────────
export { LifecycleService } from './LifecycleService';
