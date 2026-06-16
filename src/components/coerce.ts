/**
 * Defensive normaliser for LLM-mangled {@link UiComponent} inputs.
 *
 * The agent emits the wire shape from a probabilistic model, so a small
 * set of shape mistakes recur on every other call (JSON-stringifying
 * nested objects, passing a bare body string where a `props` object
 * belongs, table columns as flat string arrays, etc.). Rather than
 * bouncing those back as "invalid component" and burning a round-trip,
 * we absorb the predictable ones here and let the validator catch what
 * remains.
 *
 * This is NOT a validator. It returns whatever it can salvage —
 * possibly still malformed — and the downstream validator decides
 * acceptance. Never throws. Pure: no I/O.
 */

/**
 * Per-kind primary-field hint — the field that takes a bare string
 * when the LLM hands us `props: 'just the body text'`.
 */
const PRIMARY_FIELD: Record<string, string> = {
    markdown: 'body',
    code: 'body',
    thinking: 'text',
    status: 'text',
};

/**
 * Per-kind known props field names — when the LLM puts these at the
 * top level of the component (alongside `kind`) instead of inside
 * `props`, we migrate them. Common LLM quirk: collapsing the nested
 * shape into a flat object.
 *
 *   ❌ `{ kind: 'markdown', body: '…' }`
 *   ✅ `{ kind: 'markdown', props: { body: '…' } }`
 */
const KNOWN_PROPS_FIELDS: Record<string, readonly string[]> = {
    markdown: ['body'],
    code: ['body', 'language', 'caption'],
    thinking: ['text'],
    status: ['text', 'level'],
    progress: ['label', 'current', 'total'],
    attachment: ['path', 'url', 'filename', 'mimeType', 'caption'],
    metric: ['label', 'value', 'unit', 'delta'],
    'data-ref': ['file', 'view', 'caption'],
    'file-link': ['path', 'label'],
    image: ['url', 'alt', 'caption'],
    link: ['url', 'title', 'description'],
    table: ['columns', 'rows', 'caption', 'footer'],
    tree: ['nodes'],
    chart: ['spec', 'caption'],
    hitl: ['render', 'expect', 'resumePrompt', 'nextSteps'],
};

const DEFAULT_RESUME_PROMPT = 'User said: {value}.';

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Slug a column label into a stable id: lower-case, alnum + `_`,
 *  trimmed. Falls back to `_col` for label that slugs to empty. */
function slugify(label: string): string {
    const s = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
    return s.length > 0 ? s : '_col';
}

/** Try `JSON.parse` only on strings that look like an object/array
 *  literal. Returns `undefined` on parse failure. */
function tryParseJson(s: string): unknown | undefined {
    const trimmed = s.trim();
    if (trimmed.length === 0) return undefined;
    const first = trimmed[0];
    if (first !== '{' && first !== '[') return undefined;
    try {
        return JSON.parse(trimmed);
    } catch {
        return undefined;
    }
}

/** Coerce a single column entry — `'Region'` → `{id: 'region', label: 'Region'}`. */
function coerceColumn(col: unknown): unknown {
    if (typeof col === 'string') {
        return { id: slugify(col), label: col };
    }
    if (isPlainObject(col)) {
        // Repair `{id: '', label: 'Region'}` by re-slugging from the label.
        if ((col.id === '' || col.id === undefined || col.id === null) && typeof col.label === 'string' && col.label.length > 0) {
            return { ...col, id: slugify(col.label) };
        }
    }
    return col;
}

/**
 * Coerce one possibly-LLM-mangled UI component into a shape the
 * structural validator will accept. Returns input unchanged when
 * already well-formed.
 *
 * Coercions, in order:
 *   1. Whole-component JSON-stringified → `JSON.parse` + recurse.
 *   2. `props` as a JSON-string → parsed object.
 *   3. `props` as a bare string + kind has a primary field → wrap as
 *      `{ [primary]: str }`.
 *   4. `table.props.columns` array containing strings → expand each
 *      into `{ id: slug(s), label: s }`.
 *   5. Recurse into `hitl.props.render[*]` so the renderables get the
 *      same treatment.
 */
export function coerceUiComponent(raw: unknown): unknown {
    // (1) Whole component as a JSON-stringified blob.
    if (typeof raw === 'string') {
        const parsed = tryParseJson(raw);
        if (parsed !== undefined) {
            return coerceUiComponent(parsed);
        }
        return raw;
    }

    if (!isPlainObject(raw)) {
        return raw;
    }

    const out: Record<string, unknown> = { ...raw };
    const kind = typeof out.kind === 'string' ? out.kind : undefined;

    // (2 + 3) Normalise `props`.
    if (typeof out.props === 'string') {
        const parsed = tryParseJson(out.props);
        if (isPlainObject(parsed)) {
            out.props = parsed;
        } else if (kind && PRIMARY_FIELD[kind]) {
            out.props = { [PRIMARY_FIELD[kind]]: out.props };
        }
    }

    // (3b) Migrate flat-shape: when the LLM puts known-props fields
    //      at the top level (alongside `kind` / `slotId`) instead of
    //      inside `props`, fold them in. Common quirk.
    if (kind && KNOWN_PROPS_FIELDS[kind]) {
        const knownProps = KNOWN_PROPS_FIELDS[kind];
        const migrated: Record<string, unknown> = isPlainObject(out.props) ? { ...out.props } : {};
        let didMigrate = false;
        for (const field of knownProps) {
            if (field in out && !(field in migrated) && field !== 'props') {
                migrated[field] = out[field];
                delete out[field];
                didMigrate = true;
            }
        }
        if (didMigrate || !isPlainObject(out.props)) {
            out.props = migrated;
        }
    }

    // (4) Table column repair lives inside props.
    if (kind === 'table' && isPlainObject(out.props)) {
        const props = { ...out.props };
        if (Array.isArray(props.columns)) {
            props.columns = props.columns.map(coerceColumn);
        }
        out.props = props;
    }

    // (5) Recurse into hitl.props.render. Also default a missing
    //     resumePrompt — the engine needs SOMETHING template-shaped;
    //     letting validation fail just wastes a round-trip.
    if (kind === 'hitl' && isPlainObject(out.props)) {
        const props = { ...out.props };
        if (Array.isArray(props.render)) {
            props.render = props.render.map((r) => coerceUiComponent(r));
        }
        if (typeof props.resumePrompt !== 'string' || props.resumePrompt.length === 0) {
            props.resumePrompt = DEFAULT_RESUME_PROMPT;
        }
        out.props = props;
    }

    return out;
}
