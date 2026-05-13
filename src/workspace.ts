/**
 * Workspace Format Types
 *
 * Types describing the portable tool-manifest shape used by the deployer
 * when bootstrapping workspace branches from skill definitions.
 *
 * The generator functions (skill → WORKSPACE.md / TOOLS.json / *.sh)
 * have been removed — they were unused by the backend. If a deployer
 * needs them back, regenerate from the skill registry directly.
 */

export interface ToolsManifest {
    skill: string;
    description: string;
    tools: ToolManifestEntry[];
    generatedAt: string;
}

export interface ToolManifestEntry {
    name: string;
    description: string;
    freshness?: string;
    parameters?: ToolManifestParam[];
}

export interface ToolManifestParam {
    name: string;
    type: string;
    required: boolean;
    description?: string;
    enum?: (string | number)[];
    default?: unknown;
}
