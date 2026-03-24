// Library entry point — Ernesto v2 (filesystem-based)

// ─── Core ────────────────────────────────────────────────────────────────
export { Ernesto } from './Ernesto';
export type { ErnestoSnapshot, WorkspaceProvider, FullWorkspaceProvider } from './Ernesto';

// ─── Session ─────────────────────────────────────────────────────────────
export { Session } from './Session';
export type { SessionUser, SettleResult } from './Session';

// ─── Skills (OpenClaw primitives) ────────────────────────────────────────
export { createSkill, createTool, defineSuggestions, toolResult, toolResultWithSuggestions } from './skill';
export type {
    Skill, SkillTool, ToolContext, SkillContext, ToolResult, Suggestion, Freshness,
    ToolConfig, SuggestionRule, SuggestionSchema, SuggestionTarget,
    DomainSearchConfig, SearchSegment,
} from './skill';
export { SkillRegistry } from './skill-registry';
export type { SkillSnapshot, ToolRef, SkillSourceInfo } from './skill-registry';
export { skillToMarkdown, skillFromMarkdown } from './skill-io';

// ─── Soul ────────────────────────────────────────────────────────────────
export { renderSoul } from './soul';
export type { Soul } from './soul';

// ─── Heartbeat ───────────────────────────────────────────────────────────
export type { HeartbeatConfig, TimeWindow } from './heartbeat';

// ─── Pipelines ───────────────────────────────────────────────────────────
export { generateSourceId, ContentPipeline } from './pipelines';

// ─── Typesense ───────────────────────────────────────────────────────────
export { searchMcpResources, exportSourceDocuments, getSourceFreshness, getMcpResourceStats } from './typesense/client';
export type { SearchMcpResourcesOptions } from './typesense/client';
export type { McpResourceSearchResult } from './typesense/schema';
export { searchResourcesCrossDomain } from './typesense/search';
export type { CrossDomainSearchOptions, ResourceSearchResult } from './typesense/search';

// ─── Types ───────────────────────────────────────────────────────────────
export { DEFAULT_CACHE_TTL_MS } from './types';
export type { ResourceNode, RawContent, ContentFormat, ContentSource, PipelineConfig, RawDocument } from './types';

// ─── Components (json-render generative UI) ─────────────────────────────
export { ernestoSchema, baseCatalog, getCatalog } from './components';
export type { ErnestoCatalog, Channel as UIChannel, UISpec, UIElement } from './components';

// ─── Lifecycle ───────────────────────────────────────────────────────────
export { LifecycleService } from './LifecycleService';

// ─── Schema Formatter ────────────────────────────────────────────────────
export { formatZodSchemaForAgent } from './schema-formatter';
