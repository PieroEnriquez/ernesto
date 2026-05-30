/** Internal template-substitution helper shared by the HITL resume
 *  prompt builder (`hitl.ts`) and the default renderer strategy
 *  (`conversation-state.ts`). NOT part of the package's public surface —
 *  deliberately not re-exported from the barrel.
 *
 *  Substitution:
 *    - `{value}` is replaced with the response (objects + arrays are
 *      JSON-stringified, scalars get their `String(...)` form).
 *    - For an object-shaped response, each top-level `{field}` is
 *      replaced with the field's value (scalars only — nested objects
 *      stringify back via the `{value}` path).
 *
 *  Absent template → returns the renderer-default framing
 *  (`"The user responded: <value>"`). */

/** Scalar serializer used by the substitution helper. */
function scalar(v: unknown): string {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    try {
        return JSON.stringify(v);
    } catch {
        return String(v);
    }
}

export function substituteFields(
    template: string | undefined,
    value: unknown,
): string {
    if (!template || template.length === 0) {
        return `The user responded: ${scalar(value)}`;
    }
    let out = template.replace(/\{value\}/g, scalar(value));
    if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value)
    ) {
        for (const [field, fieldValue] of Object.entries(
            value as Record<string, unknown>,
        )) {
            const placeholder = new RegExp(
                `\\{${field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`,
                'g',
            );
            out = out.replace(placeholder, scalar(fieldValue));
        }
    }
    return out;
}
