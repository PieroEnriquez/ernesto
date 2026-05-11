export { defineExtraction } from './define-extraction';
export type {
    ExtractionPlugin,
    ExtractionPluginConfig,
    ExtractionContext,
    ExtractionLogger,
    ExtractionUser,
    ExtractionRequest,
    ExtractionResult,
    ExtractionEntry,
    ExtractionScope,
} from './define-extraction';

export { ExtractionRegistry } from './extraction-registry';

export { dispatchExtraction } from './dispatch';
export type { DispatchExtractionResult, DispatchExtractionErrorCode } from './dispatch';

export { clickupPlugin } from './plugins/clickup';
export type { ClickUpPluginOptions } from './plugins/clickup';

export { drivePlugin } from './plugins/drive';
export type { DrivePluginOptions } from './plugins/drive';

export { qasePlugin } from './plugins/qase';
export type { QasePluginOptions } from './plugins/qase';

export { githubPlugin } from './plugins/github';
export type { GitHubPluginOptions } from './plugins/github';

export { slackPlugin } from './plugins/slack';
export type { SlackPluginOptions } from './plugins/slack';
