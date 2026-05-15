// Library entry point

// ─── Workdir kernel ──────────────────────────────────────────────────────
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
