/**
 * One shared YAML-frontmatter splitter.
 *
 * Several markdown readers (`.dashboard.md` specs, managed-agent `.md`
 * files, the `_platform/WORKSPACE.md` / `_platform/<transport>.md` overlay bodies) each used to
 * hand-roll the same `^---\n…\n---\n` split. They had drifted on the
 * edges (one required the fence, another treated a fence-less file as a
 * pure body; the body slice differed). This is the single source of
 * truth for the *raw* split — schema parsing / projection of the
 * frontmatter and any trimming of the body stay with each caller.
 *
 * Canonical semantics:
 *   - A leading fence is a `---` line (LF or CRLF) followed by content,
 *     a closing `---` line, and an optional trailing newline. When
 *     present, `frontMatter` is the text *between* the fences (untrimmed)
 *     and `body` is everything *after* the closing fence (untrimmed).
 *   - No leading fence (or an unterminated one) → `{ frontMatter: '',
 *     body: raw }`. The whole input is the body. Callers that *require*
 *     frontmatter detect this by testing `frontMatter === ''`.
 *   - CRLF is handled on both the opening and closing fence lines via
 *     `\r?\n`, so a Windows-authored file splits identically to a
 *     Unix-authored one.
 *
 * Neither group is trimmed here — callers that want a trimmed body
 * (dashboards, managed-agents) call `.trim()` themselves; callers that
 * must preserve trailing newlines (the platform-body append) keep the
 * raw slice.
 */
export function readFrontmatter(raw: string): { frontMatter: string; body: string } {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
    if (!m) return { frontMatter: '', body: raw };
    return { frontMatter: m[1], body: m[2] };
}
