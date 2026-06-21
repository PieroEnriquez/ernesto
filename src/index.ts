// Library entry point

// ─── Path security primitives ────────────────────────────────────────────
export { resolvePath, isPathWithin, containsParentSegment } from './path-security';

// ─── Workdir kernel ──────────────────────────────────────────────────────
export {
    runGit,
    tryRunGit,
    probeWorkdirHealth,
    bootstrapWorkdir,
    buildSettlePatch,
    resolveWorkspaceStagePaths,
    buildStageAddArgs,
    GENERATED_SUBDIRS,
    GENERATED_FILES,
    makeInMemoryWorkdirLock,
    makeRedisWorkdirLock,
    WorkdirLockAcquireTimeout,
    makeNodeFsAdapter,
    makeVolumeMasterFs,
    rehydrateWorkdir,
    commitTurn,
    remirrorFile,
    settleFromWorktree,
    settleFromPatch,
    overlayToDiff,
    settleFromOverlay,
    RipgrepNotInstalledError,
} from './workdir';
export type {
    FsAdapter,
    MasterFsAdapter,
    Workdir,
    WorkdirLock,
    GrepOutputMode,
    SettleResult as WorkdirSettleResult,
    SettleFromOverlayResult,
    SettleFromOverlayInput,
    LintFn,
    LintError,
    PushToMainFn,
    RedisLockClient,
} from './workdir';

// ─── Lint (workspace settle gate) ────────────────────────────────────────
export {
    lintWorkspace,
    makeLintWorkspace,
    lintWorkflowFile,
    lintAttachmentsFile,
    UNREGISTERED_EXTRACTION_SOURCE,
    EXTRACTION_CHANGE_REQUIRES_AGENT_OPS,
    INVALID_ATTACHMENTS_YAML,
    RESERVED_SYSTEM_WORKSPACES,
} from './lint';
export type { LintPrincipal } from './lint';

// ─── Workspace boundary resolution (FS-derived identity → location) ──────
export { scanWorkspaceBoundaries, boundaryForName, boundaryForPath, boundariesFromPatchPaths } from './workspaces/boundaries';
export type { WorkspaceBoundary } from './workspaces/boundaries';

// ─── Workspace access model (single source of truth) ─────────────────────
export { parseWorkspaceFrontmatter } from './workspaces/access';
export type { WorkspaceFrontmatter } from './workspaces/access';
export { validateTreeRelPath } from './workspaces/path';
export { computeWorkspaceVisibility, workspaceForPath, canReadPath, readableBoundaries, boundaryDirs } from './workspaces/visibility';
export type { WorkspaceVisibility } from './workspaces/visibility';

// ─── Workspace attachments index (the attachments.yaml contract) ─────────
export {
    ATTACHMENTS_YAML,
    SHA256_HEX_RE,
    validateAttachmentsYaml,
    serializeAttachmentsYaml,
    isSafeAttachmentName,
    collisionSuffixedName,
    upsertAttachmentEntry,
    removeAttachmentEntry,
} from './workspaces/attachments';
export type { AttachmentEntry, AttachmentsYamlIssue } from './workspaces/attachments';

// ─── Workspace overlay VIEW (read side of the content-overlay model) ─────
export { makeOverlayView, emptyPatch } from './workspaces/overlay';
export type { WorkspacePatch, OverlayView, FsReader, FsReaderDirent } from './workspaces/overlay';

// ─── Workflows (declaration + composition + lint) ────────────────────────
export {
    parseWorkflowYaml,
    compileManagedAgentMdToWorkflow,
    isAgentStep,
    isDynamicWorkflowStep,
    parseDynamicWorkflowJs,
    DynamicWorkflowParseError,
} from './workflows';
export type {
    WorkflowDeclaration,
    WorkflowStep,
    InputStep,
    AgentStep,
    AgentHarness,
    AgentExecution,
    DynamicWorkflowStep,
    StepKind,
} from './workflows';

// ─── Routes ──────────────────────────────────────────────────────────────
//
// `dispatchRoute` and `dispatchResolvedRoute` intentionally do NOT
// appear on the top-level package surface. The unified runtime's
// `runner.dispatch(uri, params, principal)` is the supported entry
// point for routes (it goes through the kind registry + middleware
// chain + event store); the sync route primitive lives at
// `ernesto/route` for tests + advanced internal use.
export { defineRoute, RouteRegistry, selectPhysicalProjector } from './route';
export type { DispatchResult, DispatchErrorCode, RenderEntry } from './route';
export type { WorkspaceView, RouteContext, SettleStaging, SettleDraftStore, ReconcileResult } from './route/define-route';
export type { PhysicalProjector, WriteThroughEngine, SelectPhysicalProjectorOpts } from './route';

// ─── Managed agents (declaration + composition) ──────────────────────────
export {
    composeErnestoBody,
    parseManagedAgentMd,
    toAgentDeclaration,
    composeExtends,
    MAX_EXTENDS_DEPTH,
    gitBlobShaOf,
    verifyContentMatchesFileSha,
    resolveHarness,
} from './managed-agents';
export type { SystemPromptConfig, JsonSchemaOutputFormat, ManagedAgentMd, Transport, Isolation } from './managed-agents';

// ─── Agent verbs ─────────────────────────────────────────────────────────
export { executeInputSchema, EXECUTE_DESCRIPTION, handleExecute, settleInputSchema, SETTLE_DESCRIPTION, handleSettle } from './agent-verbs';
export type { SettleInput as SettleVerbInput } from './agent-verbs';

// ─── Harness (runtime abstraction) ───────────────────────────────────────
export type { Harness, AgentHandle, RunHandle, HarnessEvent, AgentDefinition, RunResult, CreateOptions, SubagentDef } from './harness';
// Mock harness is sub-export only: import from 'ernesto/harness/mock'
// CAS harness is sub-export only (peer dep): import from 'ernesto/harness/cas'

// ─── Brain FS routes (the universal primitive) ───────────────────────────
// `brain://read|write|edit|glob|grep` — same route family on every
// transport. Each transport registers this once; the agent calls them
// via `execute`. Per-transport specialization is in the dispatch
// transport (in-process, MCP-over-HTTP, laptop hook), not in the
// contract. "The brain" is Ernesto's master-fs — its canonical
// persistent state.
export { registerBrainRoutes } from './routes/brain';

// ─── Components (declarative UI intent) ──────────────────────────────────
// Components are a sub-export only: import from 'ernesto/components'.

// ─── Extractions ─────────────────────────────────────────────────────────
export {
    defineExtraction,
    ExtractionRegistry,
    dispatchExtraction,
    clickupPlugin,
    drivePlugin,
    qasePlugin,
    githubPlugin,
    slackPlugin,
    crowdinPlugin,
    devinPlugin,
    redshiftSchemaPlugin,
} from './extraction';
export type { ExtractionContext, ExtractionRequest, ExtractionResult, DispatchExtractionResult } from './extraction';
