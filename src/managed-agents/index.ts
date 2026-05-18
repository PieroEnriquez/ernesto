export { compileAgent, composePlatformBody } from './compile-agent';
export { parseManagedAgentMd, toAgentDeclaration, composeExtends, MAX_EXTENDS_DEPTH } from './from-md';
export type { ManagedAgentMd, ExtendsResolver } from './from-md';
export { gitBlobShaOf, verifyContentMatchesFileSha } from './file-sha';
export type {
    AgentDeclaration,
    AgentContext,
    CompiledAgent,
    SystemPromptConfig,
    JsonSchemaOutputFormat,
    TierId,
} from './types';
