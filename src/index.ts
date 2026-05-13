// Library entry point

// ─── Core ────────────────────────────────────────────────────────────────
export { Ernesto } from './Ernesto';

// ─── Skills ──────────────────────────────────────────────────────────────
export { createSkill, createTool, defineSuggestions, toolResult, toolResultWithSuggestions } from './skill';
export type {
    Skill, SkillTool, ToolContext, SkillContext, ToolResult, Suggestion, Freshness,
} from './skill';
export { SkillRegistry } from './skill-registry';

// ─── Session ─────────────────────────────────────────────────────────────
export type { SessionUser, WorkspaceProvider, SettleResult } from './Session';

// ─── Search (optional provider interface) ────────────────────────────────
export type { SearchProvider, SearchOptions, SearchResult } from './search';

// ─── Workspace Format (types only) ───────────────────────────────────────
export type { ToolsManifest, ToolManifestEntry, ToolManifestParam } from './workspace';

// ─── Soul ────────────────────────────────────────────────────────────────
export type { Soul } from './soul';

// ─── Pipelines ───────────────────────────────────────────────────────────
export { generateSourceId, ContentPipeline } from './pipelines';

// ─── Types ───────────────────────────────────────────────────────────────
export { DEFAULT_CACHE_TTL_MS } from './types';
export type { ResourceNode, RawContent, ContentFormat, ContentSource, PipelineConfig, RawDocument } from './types';

// ─── Utilities ───────────────────────────────────────────────────────────
export { formatZodSchemaForAgent } from './schema-formatter';
export { flattenResources } from './utils';

// ─── Workdir kernel (new) ────────────────────────────────────────────────
export {
    runGit, makeInMemoryWorkdirLock,
    makeRedisWorkdirLock, WorkdirLockAcquireTimeout,
    makeInMemoryFsAdapter, makeInMemoryMasterFs,
    makeNodeFsAdapter, makeVolumeMasterFs,
    makeHttpsMasterFs,
    bootWorkdir, rehydrateWorkdir,
    commitTurn, materializeFile, remirrorFile, settleFromWorktree,
} from './workdir';
export type {
    FsAdapter, MasterFsAdapter, MasterFsResolution,
    Workdir, WorkdirInput, WorkdirLock, WorkdirTier,
    LayoutEntry, BootInput, BootResult,
    CommitTurnInput, CommitTurnResult,
    MaterializeResult,
    SettleInput, SettleResult as WorkdirSettleResult,
    LintFn, LintInput, LintError, PushToMainFn,
    RedisLockClient,
    HttpsMasterFsOptions,
} from './workdir';

// ─── Lint (workspace settle gate) ────────────────────────────────────────
export {
    lintWorkspace,
    makeLintWorkspace,
    makeScopelessLintWorkspace,
    UNREGISTERED_EXTRACTION_SOURCE,
} from './lint';
export type { LintPrincipal, MakeLintWorkspaceOptions } from './lint';

// ─── Routes ──────────────────────────────────────────────────────────────
export { defineRoute, RouteRegistry, dispatchRoute } from './route';
export type {
    Route, RouteConfig, RouteContext, RouteLogger, RouteScope, RouteUser,
    DispatchResult, DispatchErrorCode,
} from './route';

// ─── Agent verbs ─────────────────────────────────────────────────────────
export {
    executeInputSchema, executeOutputSchema, EXECUTE_DESCRIPTION, handleExecute,
    settleInputSchema, settleOutputSchema, SETTLE_DESCRIPTION, handleSettle,
} from './agent-verbs';
export type {
    ExecuteInput, ExecuteVerbContext, ExecuteVerbLogger,
    SettleInput as SettleVerbInput,
    SettleVerbContext, SettleVerbLogger, SettleVerbHooks, SettleVerbResult,
    VerbLogger, VerbUser,
} from './agent-verbs';

// ─── Extractions ─────────────────────────────────────────────────────────
export { defineExtraction, ExtractionRegistry, dispatchExtraction, clickupPlugin, drivePlugin, qasePlugin, githubPlugin, slackPlugin } from './extraction';
export type {
    ExtractionPlugin, ExtractionPluginConfig, ExtractionContext, ExtractionLogger,
    ExtractionUser, ExtractionRequest, ExtractionResult, ExtractionEntry,
    ExtractionScope,
    DispatchExtractionResult, DispatchExtractionErrorCode,
    ClickUpPluginOptions,
    DrivePluginOptions,
    QasePluginOptions,
    GitHubPluginOptions,
    SlackPluginOptions,
} from './extraction';
