/**
 * `.dashboard.md` spec — Zod schema, frontmatter parser, and bind
 * substitution. Shared between the admin-panel runtime renderer and
 * any server-side consumer (settle-time lint, Slack snapshots, PDF
 * export, the `dashboard-author` managed agent's self-validation).
 */

export {
    SLUG_RE,
    BLOCK_ID_RE,
    FORMAT_VALUES,
    formatSchema,
    filterSchema,
    blockSchema,
    dashboardSpecSchema,
    isDataBlock,
    isSqlBlock,
    isJsBlock,
} from './schema';
export type {
    Format,
    Filter,
    Block,
    SqlBlock,
    JsBlock,
    DataBlock,
    DashboardSpec,
    ParsedDashboard,
    DateRangeDefault,
} from './schema';

export { dataflowOrder } from './dataflow';

export {
    parseDashboard,
    DashboardSpecError,
    RESERVED_BIND_NAMES,
} from './parse';

export {
    substituteBinds,
    toDateId,
} from './bind';
export type {
    BoundQuery,
    FilterValue,
    FilterValues,
    DateRangeValue,
} from './bind';
