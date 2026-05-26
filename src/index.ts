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
    lintWorkflowFile,
    isWorkflowPath,
    UNREGISTERED_EXTRACTION_SOURCE,
    RESERVED_SYSTEM_WORKSPACES,
} from './lint';
export type { LintPrincipal, MakeLintWorkspaceOptions } from './lint';

// ─── Workflows (declaration + composition + lint) ────────────────────────
export {
    parseWorkflowYaml,
    compileManagedAgentMdToWorkflow,
    compileDashboardSpecToWorkflow,
    validateWorkflow,
    isAgentStep,
} from './workflows';
export type {
    WorkflowDeclaration, WorkflowStep, RouteStep, InputStep,
    AgentStep, AgentHarness,
    SubworkflowStep, GroupStep,
    WorkflowInput, WorkflowOutput, StepKind,
    WorkflowValidationResult, WorkflowValidationError, WorkflowLintCode,
    WorkflowValidateContext,
} from './workflows';

// ─── Routes ──────────────────────────────────────────────────────────────
//
// `dispatchRoute` and `dispatchResolvedRoute` intentionally do NOT
// appear on the top-level package surface. The unified runtime's
// `runner.dispatch(uri, params, principal)` is the supported entry
// point for routes (it goes through the kind registry + middleware
// chain + event store); the sync route primitive lives at
// `ernesto/route` for tests + advanced internal use.
export {
    defineRoute, resolveRouteScope, isDynamicScope,
    RouteRegistry,
    applyRenderManifest,
    sketchComponents,
} from './route';
export type {
    Route, RouteConfig, RouteContext, RouteLogger, RouteScope, RouteUser,
    DynamicScope,
    DispatchResult, DispatchErrorCode,
    RenderEntry, WhenClause, ManifestComponent,
    StagedSketch,
} from './route';
export type { RouteCompactor } from './route/route-registry';

// ─── Route results (archive + compact preview) ─────────────────────────
export {
    archiveRouteResult, ARCHIVE_MAX_BYTES,
    compactify,
} from './route-results';
export type {
    ArchiveRouteResultInput, ArchiveFile, ArchiveLogger,
    CompactArrayWrapper,
} from './route-results';

// ─── Managed agents (declaration + composition) ──────────────────────────
export {
    compileAgent, composePlatformBody,
    parseManagedAgentMd, toAgentDeclaration,
    composeExtends, MAX_EXTENDS_DEPTH,
    gitBlobShaOf, verifyContentMatchesFileSha,
    resolveHarness,
} from './managed-agents';
export type {
    AgentDeclaration, AgentContext, CompiledAgent,
    SystemPromptConfig, JsonSchemaOutputFormat,
    ManagedAgentMd, ExtendsResolver, TierId,
} from './managed-agents';

// ─── Agent verbs ─────────────────────────────────────────────────────────
export {
    executeInputSchema, executeOutputSchema, EXECUTE_DESCRIPTION,
    EXECUTE_ACCEPTS_BUNDLED_UI, handleExecute,
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

// ─── Harness (runtime abstraction) ───────────────────────────────────────
export type {
    Harness, AgentHandle, RunHandle, HarnessEvent,
    HarnessCapabilities, AgentDefinition, ToolSpec, ModelRef,
    ModelInfo, AgentInfo, RunResult, HarnessMessage,
    UserMessage, AssistantBlock, RunStatus,
    CreateOptions, SendOptions, ListOptions, ListResult, SubagentDef,
} from './harness';
export { createMockHarness } from './harness/mock';
// CAS harness is sub-export only (peer dep): import from 'ernesto/harness/cas'

// ─── Brain FS routes (the universal primitive) ───────────────────────────
// `brain://read|write|edit|glob|grep` — same route family on every
// tier. Tiers register this once; the agent calls them via `execute`.
// Per-tier specialization is in the dispatch transport (in-process,
// MCP-over-HTTP, Claude-Code-hook), not in the contract. "The brain"
// is Ernesto's master-fs — its canonical persistent state.
export { registerBrainRoutes } from './routes/brain';

// ─── Components (declarative UI intent) ──────────────────────────────────
export {
    UI_COMPONENT_KINDS,
    RENDERABLE_COMPONENT_KINDS,
    validateUiComponent,
    validateThinking,
    validateStatus,
    validateProgress,
    validateAttachment,
    validateHitl,
    validateRenderableComponent,
} from './components';
export type {
    UiComponent,
    UiComponentKind,
    ThinkingComponent,
    StatusComponent,
    ProgressComponent,
    AttachmentComponent,
    HitlComponent,
    HitlExpect,
    NextStep,
    RenderableComponent,
    RenderableComponentKind,
    MarkdownProps,
    DataRefProps,
    FileLinkProps,
    TableProps,
    TableColumn,
    TableRow,
    MetricProps,
    MetricDelta,
    ChartProps,
    CodeProps,
    ImageProps,
    LinkProps,
    TreeProps,
    TreeNode,
    ValidationResult,
} from './components';

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
