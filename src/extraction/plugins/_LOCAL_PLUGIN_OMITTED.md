# Local Plugin — Intentionally Omitted

There is no `local.ts` extraction plugin, and there should not be one.

## What a "local" plugin would do

A legacy host-side `LocalSource`
wraps `fs.readdirSync` / `fs.readFileSync`: given a root directory, it walks the
tree, filters by extension, detects content type from the extension, and
returns `{ id, name, path, content }`.

## Why we don't port it

Inside a workspace, Ernesto runs as an agent with native filesystem access.
The agent's built-in tools already cover the same surface — and do it
better, because they participate in the harness's permission and audit
model:

| LocalSource capability   | Native agent equivalent                 |
| ------------------------ | --------------------------------------- |
| Recursive directory walk | `Glob` (`**/*.md`, etc.)                |
| Read file contents       | `Read` (with line ranges, images, PDFs) |
| Filter by extension      | `Glob` pattern / `Grep --type`          |
| Content-type sniffing    | `Read` handles md/txt/pdf/png/ipynb     |
| Search inside files      | `Grep` (ripgrep)                        |

A plugin wrapper would add a second, weaker path to the same bytes —
duplicated traversal logic, duplicated path-traversal hardening, and a
`source: 'local'` scope that means "read anything the process can read."
That's a scope we don't want to grant when the agent can already read
exactly what it needs through audited tools.

## When a plugin _would_ be justified

Only if extraction needs to reach **outside the workspace tree** — a sibling
repo, a shared docs mount, an asset store on a different volume. That's a
different plugin (`source`, scope, and root config), not a generalized
"local". Build it then, scoped to that specific root.

## TL;DR

Workspace files → use `Read` / `Glob` / `Grep` directly. No plugin.
