// Library entry point

// ─── Path security primitives ────────────────────────────────────────────
export {
    resolvePath,
    resolveAllowedDir,
    isPathWithin,
    containsParentSegment,
} from './path-security';

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
    RipgrepNotInstalledError,
} from './workdir';
export type {
    FsAdapter, MasterFsAdapter, MasterFsResolution,
    Workdir, WorkdirInput, WorkdirLock, WorkdirTier,
    LayoutEntry, BootInput, BootResult,
    GlobOptions, GrepOptions, GrepResult, GrepOutputMode,
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
    RESERVED_SYSTEM_WORKSPACES,
} from './lint';
export type { LintPrincipal, MakeLintWorkspaceOptions } from './lint';

// ─── Routes ──────────────────────────────────────────────────────────────
export {
    defineRoute, resolveRouteScope, isDynamicScope,
    RouteRegistry, dispatchRoute,
} from './route';
export type {
    Route, RouteConfig, RouteContext, RouteLogger, RouteScope, RouteUser,
    DynamicScope,
    DispatchResult, DispatchErrorCode,
} from './route';

// ─── Managed agents (declaration + composition) ──────────────────────────
export {
    compileAgent, composePlatformBody,
    parseManagedAgentMd, toAgentDeclaration,
    composeExtends, MAX_EXTENDS_DEPTH,
    gitBlobShaOf, verifyContentMatchesFileSha,
} from './managed-agents';
export type {
    AgentDeclaration, AgentContext, CompiledAgent,
    SystemPromptConfig, JsonSchemaOutputFormat,
    ManagedAgentMd, ExtendsResolver, TierId,
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

// ─── Dashboards spec ─────────────────────────────────────────────────────
export {
    dashboardSpecSchema,
    blockSchema,
    filterSchema,
    formatSchema,
    isDataBlock,
    isSqlBlock,
    isJsBlock,
    parseDashboard,
    substituteBinds,
    toDateId,
    dataflowOrder,
    DashboardSpecError,
    RESERVED_BIND_NAMES,
    SLUG_RE as DASHBOARD_SLUG_RE,
    BLOCK_ID_RE,
    FORMAT_VALUES,
} from './dashboards';
export type {
    DashboardSpec,
    ParsedDashboard,
    Block,
    SqlBlock,
    JsBlock,
    DataBlock,
    Filter,
    Format,
    DateRangeDefault,
    BoundQuery,
    FilterValue,
    FilterValues,
    DateRangeValue,
} from './dashboards';

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
