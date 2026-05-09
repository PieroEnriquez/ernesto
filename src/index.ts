// Library entry point

// ─── Core ────────────────────────────────────────────────────────────────
export { Ernesto } from './Ernesto';
export type { ErnestoSnapshot } from './Ernesto';

// ─── Skills ──────────────────────────────────────────────────────────────
export { createSkill, createTool, defineSuggestions, toolResult, toolResultWithSuggestions } from './skill';
export type {
    Skill, SkillTool, ToolContext, SkillContext, ToolResult, Suggestion, Freshness,
    ToolConfig, SuggestionRule, SuggestionSchema, SuggestionTarget,
} from './skill';
export { SkillRegistry } from './skill-registry';
export type { SkillSnapshot, ToolRef } from './skill-registry';

// ─── Session ─────────────────────────────────────────────────────────────
export type { SessionUser, WorkspaceProvider, SettleResult } from './Session';

// ─── Search (optional provider interface) ────────────────────────────────
export type { SearchProvider, SearchOptions, SearchResult } from './search';

// ─── Workspace Format ────────────────────────────────────────────────────
export { skillToWorkspaceMd, skillToToolsJson, generateToolScript, generateAllToolScripts } from './workspace';
export type { ToolsManifest, ToolManifestEntry, ToolManifestParam } from './workspace';

// ─── Soul ────────────────────────────────────────────────────────────────
export { renderSoul } from './soul';
export type { Soul } from './soul';

// ─── Heartbeat ───────────────────────────────────────────────────────────
export type { HeartbeatConfig, TimeWindow } from './heartbeat';

// ─── Pipelines ───────────────────────────────────────────────────────────
export { generateSourceId, ContentPipeline } from './pipelines';

// ─── Types ───────────────────────────────────────────────────────────────
export { DEFAULT_CACHE_TTL_MS } from './types';
export type { ResourceNode, RawContent, ContentFormat, ContentSource, PipelineConfig, RawDocument } from './types';

// ─── Utilities ───────────────────────────────────────────────────────────
export { formatZodSchemaForAgent } from './schema-formatter';
export { truncateText, flattenResources } from './utils';

// ─── Workdir kernel (new) ────────────────────────────────────────────────
export {
    runGit, makeInMemoryWorkdirLock,
    makeInMemoryFsAdapter, makeInMemoryMasterFs,
    makeNodeFsAdapter, makeVolumeMasterFs,
    bootWorkdir, rehydrateWorkdir,
    commitTurn, materializeFile, settleFromWorktree,
} from './workdir';
export type {
    FsAdapter, MasterFsAdapter, MasterFsResolution,
    Workdir, WorkdirInput, WorkdirLock, WorkdirTier,
    LayoutEntry, BootInput, BootResult,
    CommitTurnInput, CommitTurnResult,
    MaterializeResult,
    SettleInput, SettleResult as WorkdirSettleResult,
    LintFn, LintInput, LintError, PushToMainFn,
} from './workdir';
