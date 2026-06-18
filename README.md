# Native Memory Citations

Native Memory Citations is an OpenClaw plugin for controlled, cited retrieval from
local workspace memory files. ("Native" denotes an OpenClaw-native plugin, not
native system memory.)

The plugin is built for environments where memory access must be explicit, bounded,
and auditable. An operator defines which workspace files or directories may be
searched. The plugin enforces that access boundary before reading any content,
redacts secret-shaped material from what it returns, and attaches citation metadata
so every answer can be traced back to its source. The objective is not broad memory
access; it is operator-controlled retrieval with an audit trail.

![Architecture](https://raw.githubusercontent.com/NGO-A/native-memory-citations/master/docs/architecture.svg)

## Key capabilities

- Operator-defined search scope, limited to workspace-relative roots.
- Optional shared mode that excludes private memory from the default set.
- Per-file size limits, with oversized files skipped rather than read.
- Redaction of secret-shaped content in all returned text (search, fetch, and answers).
- Citations on every result, with full-file SHA-256 hashes for staleness detection.
- Per-request output limits on fetched content.
- Read-only operation: the plugin never creates, modifies, or deletes memory files.

## Install

From npm (recommended):

 openclaw plugins install @ngo-a/native-memory-citations

From a local checkout (development):

 openclaw plugins install ./native-memory-citations

Reload the Gateway after installing so the plugin host exposes the tools.

## Requirements

- Node.js 22.19.0 or newer.
- OpenClaw 2026.5.17 or newer (declared as a peer dependency).
- A local OpenClaw workspace containing text memory files.

Supported memory file types are `.md`, `.txt`, `.json`, `.jsonl`, `.yaml`, and
`.yml`. Files with other extensions are not scanned.

## Intended use

Native Memory Citations is intended for OpenClaw deployments where an agent needs
access to selected memory files without broad filesystem visibility. It suits
single-user, team, and shared environments in which private memory, project notes,
identity files, and tool references must be handled within clear boundaries.

## Tools

- `native_memory_search` — search the approved roots and return snippets with source paths, line numbers, and file SHA-256 hashes.
- `native_memory_fetch` — fetch a cited source by `sourceId` or a safe path, optionally checking an expected citation hash.
- `native_memory_answer` — build an extractive answer from cited snippets, and state plainly when no cited memory is found.

## Default scope

By default the plugin searches:

- `memory/`
- `MEMORY.md`
- `USER.md`
- `IDENTITY.md`
- `TOOLS.md`

Set `sharedMode: true` to exclude the private `MEMORY.md` from this default set.
Setting `allowedRoots` explicitly overrides the default set entirely and takes
precedence over `sharedMode`.

Custom `allowedRoots` entries must be workspace-relative, visible paths. Empty
entries, `.`, `..`, paths containing `..`, absolute paths, and hidden segments such
as `memory/.dreams` are rejected.

## Configuration

Plugin configuration is supplied in the plugin's entry within the OpenClaw Gateway
configuration. It governs which files the plugin is permitted to read and cite. The
plugin reads existing memory files only; it does not create, modify, or delete them.
All keys are optional.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `workspace` | string | `$OPENCLAW_WORKSPACE`, then `~/.openclaw/workspace` | Absolute path against which roots are resolved. |
| `allowedRoots` | string[] | Built-in default set (see Default scope) | Workspace-relative files or directories to search. When set to a non-empty array, it replaces the default set in full. |
| `sharedMode` | boolean | `false` | When `true`, excludes the private `MEMORY.md` from the default set. Has no effect when `allowedRoots` is set. |
| `maxFileBytes` | number | `1048576` (1 MiB) | Per-file size limit. Files exceeding this limit are skipped rather than reported as errors. |

### Default search scope

The default roots are listed in Default scope above: `memory/`, `MEMORY.md`,
`USER.md`, `IDENTITY.md`, and `TOOLS.md`. With `sharedMode: true`, `MEMORY.md` is
excluded.

### Defining custom roots

Set `allowedRoots` to the exact set of workspace-relative files or directories that
should be searchable. This value replaces the default set in full and takes
precedence over `sharedMode`. Any default entries that should remain searchable must
be listed explicitly.

Each entry must be a workspace-relative, visible path. An entry is rejected, with an
`Invalid allowedRoots entry` error, if it is empty, `.`, `..`, an absolute path,
contains a `..` segment, or contains a hidden segment (a segment beginning with `.`,
for example `memory/.dreams`). These restrictions are part of the access boundary
and are enforced intentionally.

### Examples

Shared or team deployment, retaining the defaults while excluding the private
journal:

```json
{ "sharedMode": true }
```

Restricting the plugin to a specific, minimal set:

```json
{ "allowedRoots": ["memory", "USER.md"] }
```

Adding custom directories. Because `allowedRoots` replaces the default set, any
defaults that should remain searchable are listed again:

```json
{ "allowedRoots": ["memory", "USER.md", "IDENTITY.md", "TOOLS.md", "notes", "decisions"] }
```

Permitting larger files (4 MiB) and specifying a non-default workspace:

```json
{ "workspace": "/srv/openclaw/workspace", "maxFileBytes": 4194304 }
```

### Operational notes

- `allowedRoots` replaces the default set; it does not extend it. A value of
 `["notes"]` makes `MEMORY.md`, `USER.md`, and the remaining defaults unreachable.
 List every path that should remain searchable.
- `sharedMode` has no effect once `allowedRoots` is set; the explicit list takes
 precedence.
- Files exceeding `maxFileBytes` are skipped and logged rather than reported as
 errors. Set the limit to accommodate the largest memory files in use.
- Hidden directories, `..` segments, and absolute paths cannot be included. This is
 enforced by the access boundary.

### Settings not exposed through configuration

Redaction is implemented in code and is not configurable through plugin
configuration; the schema rejects unrecognized keys. The named secret patterns and
the high-entropy backstop are defined in `src/core.ts`. Modifying redaction behavior
requires editing that file and re-running the test suite (`npm test`) to confirm
that the redaction invariants continue to hold. It is not a configuration setting in
this version.

### Per-request limit

`native_memory_fetch` accepts a `maxChars` argument (default `8000`, constrained to
the range 256 to 20000) that bounds the amount of cited content returned by a single
fetch. This is a per-call tool argument and is independent of plugin configuration.

## Citation integrity

Search hits include a `sha256`, computed from the full text of the file used for
line splitting and citation line numbers. Fetch results include the current `sha256`
for the same full-file content.

To detect stale citations, pass the hash from a prior search hit:

```json
{
 "sourceId": "memory/2026-06-17.md",
 "lineStart": 12,
 "lineEnd": 14,
 "expectedSha256": "..."
}
```

If the file has changed, fetch still returns the current content for inspection but
marks the result with `stale: true` and a `staleMessage` explaining the hash
mismatch. Because hashes cover the full file, appending to a daily journal marks
earlier citations stale even when the cited lines themselves are unchanged.

## Security model

The plugin enforces a two-layer model.

The access boundary determines what may be read. `allowedRoots` is trusted operator
configuration. Any caller-supplied fetch path, and any symlink that would escape a
root, is treated as untrusted and re-checked with `realpath`. Symlinks encountered
while walking directories during search are skipped. Fetch additionally rejects
hidden path segments, non-text files, and files larger than `maxFileBytes`.

Redaction is applied to all returned text as defense-in-depth. Named secret patterns
provide readable labels for common formats; a high-entropy backstop masks unknown
long tokens. Redaction is not an authorization or access-control boundary. It does
not modify source files, and it does not affect citation hashes, which are computed
from the original file text.

To report a vulnerability, see [SECURITY.md](https://github.com/NGO-A/native-memory-citations/blob/master/SECURITY.md).

## Implementation notes

This v1 is intentionally local-file based. It is portable and dependency-light. A
future version can add vector search while keeping the same public tool names.
Search is keyword and substring based, with an mtime/size line cache, bounded scan
concurrency, and `AbortSignal` checks during the scan.

## Contributing

Development setup, manifest generation, and the release process are documented in
[CONTRIBUTING.md](https://github.com/NGO-A/native-memory-citations/blob/master/CONTRIBUTING.md).

## License

MIT. See [LICENSE](https://github.com/NGO-A/native-memory-citations/blob/master/LICENSE).

## Changelog

See [CHANGELOG.md](https://github.com/NGO-A/native-memory-citations/blob/master/CHANGELOG.md).
