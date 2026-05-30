/**
 * Test-support entry — NOT part of the production surface.
 *
 * In-memory `FsAdapter` / `MasterFsAdapter` implementations (incl. the
 * in-memory ripgrep/glob) used by tests and spec-conformance suites.
 * Importable as `ernesto/testing`; intentionally absent from the package
 * root (`ernesto`) so the production bundle never ships this scaffolding.
 */

export {
    makeInMemoryFsAdapter,
    makeInMemoryMasterFs,
} from '../workdir/in-memory-adapters';
export type { InMemoryMasterFsOptions } from '../workdir/in-memory-adapters';
