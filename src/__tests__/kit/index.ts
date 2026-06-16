/**
 * Shared test kit — ernesto lib.
 *
 * Pure workdir/git scaffolding (the lib suite has NO logger/redis mocks, so the
 * kit adds no mock-sweep and no setupFiles change). Importers use the relative
 * path to this barrel, e.g.
 *   import { buildWorkdir, setupBareRepo } from '../../__tests__/kit';
 */
export {
    buildWorkdir,
    setupBareRepo,
    makeTempTree,
    seedWorkspace,
    type BuildWorkdirOpts,
    type BuiltWorkdir,
    type BareRepo,
    type TempTree,
} from './workdir';
