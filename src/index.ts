// Library entry point

// ─── Workdir kernel ──────────────────────────────────────────────────────
export {
    runGit, tryRunGit,
    probeWorkdirHealth, bootstrapWorkdir, buildSettlePatch,
    makeInMemoryWorkdirLock,
    makeRedisWorkdirLock, WorkdirLockAcquireTimeout,
    makeInMemoryFsAdapter, makeInMemoryMasterFs,
    makeNodeFsAdapter, makeVolumeMasterFs,
    makeHttpsMasterFs,
    bootWorkdir, rehydrateWorkdir,
    commitTurn, materializeFile, remirrorFile, settleFromWorktree,
    settleFromPatch,
} from './workdir';
export type {
    FsAdapter, MasterFsAdapter, MasterFsResolution,
    Workdir, WorkdirInput, WorkdirLock, WorkdirTier,
    LayoutEntry, BootInput, BootResult,
    CommitTurnInput, CommitTurnResult,
    MaterializeResult,
    SettleInput, SettleResult as WorkdirSettleResult,
    SettleFromPatchInput, SettleFromPatchResult,
    LintFn, LintInput, LintError, PushToMainFn,
    RedisLockClient,
    HttpsMasterFsOptions,
    WorkdirHealth, BootstrapWorkdirInput,
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

// ─── Managed agents (declaration + composition) ──────────────────────────
export {
    compileAgent, composePlatformBody,
    parseManagedAgentMd, toAgentDeclaration,
    discoverManagedAgents,
    gitBlobShaOf, verifyContentMatchesFileSha,
} from './managed-agents';
export type {
    AgentDeclaration, AgentContext, CompiledAgent,
    SystemPromptConfig, JsonSchemaOutputFormat,
    ManagedAgentMd, TierId,
    DiscoveredAgent, DiscoverManagedAgentsError, DiscoverManagedAgentsResult,
} from './managed-agents';

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
export {
    defineExtraction, ExtractionRegistry, dispatchExtraction,
    clickupPlugin, drivePlugin, qasePlugin, githubPlugin, slackPlugin,
    crowdinPlugin, devinPlugin, redshiftSchemaPlugin,
} from './extraction';
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
    CrowdinPluginOptions,
    DevinPluginOptions,
    RedshiftSchemaPluginOptions,
    RedshiftQueryFn,
} from './extraction';
