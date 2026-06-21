# Native Memory Citations

[![CI](https://github.com/NGO-A/native-memory-citations/actions/workflows/ci.yml/badge.svg)](https://github.com/NGO-A/native-memory-citations/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@ngo-a/native-memory-citations)](https://www.npmjs.com/package/@ngo-a/native-memory-citations)
[![license](https://img.shields.io/github/license/NGO-A/native-memory-citations)](LICENSE)

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

## Operating modes

The plugin runs in one of two modes, selected by the `mode` configuration key.

- **`bounded` (default).** The behavior described throughout this README: read-only
 retrieval, keyword/substring search, extractive cited answers, no network calls, no
 model calls, and no changes to host configuration. This is what a default install
 does, and what every guarantee in this document refers to.
- **`enhanced` (opt-in, experimental).** Bounded mode is the stable production core;
 enhanced mode layers additional agentic-memory capabilities on top of it, reusing the
 same access boundary, redaction, and citation guarantees. This release adds a
 functional zero-LLM knowledge-graph sidecar plus experimental lifecycle scaffolding
 (snapshot injection, observation tagging, dreaming integration); richer semantic and
 reranked recall and a memory-wiki bridge are forthcoming. Every enhanced capability is
 disabled by default even in enhanced mode and is turned on explicitly, per feature.

Leaving configuration at its defaults keeps the plugin in bounded mode; an upgrade
changes nothing until you opt in. Enhanced-mode capabilities are introduced
incrementally beginning with the 2026.6.9 release - see
[Enhanced mode](#enhanced-mode-opt-in).

## Key capabilities

- Operator-defined search scope, limited to workspace-relative roots.
- Optional shared mode that excludes private memory from the default set.
- Per-file size limits, with oversized files skipped rather than read.
- Redaction of secret-shaped content in all returned text (search, fetch, and answers).
- Citations on every result, with full-file SHA-256 hashes for staleness detection.
- Per-request output limits on fetched content.
- Read-only by default: bounded mode never creates, modifies, or deletes any file, and
 in every mode the plugin never modifies your source memory files (`MEMORY.md`, daily
 notes, `DREAMS.md`). Enhanced mode, when explicitly enabled, writes only its own
 size-bounded derived sidecars (e.g. `memory/graph.jsonl`, `memory/observations.jsonl`),
 which are excluded from retrieval and citation - so generated content never feeds back
 into what the plugin returns.

## Install

From npm (recommended):

```sh
openclaw plugins install @ngo-a/native-memory-citations
```

From a local checkout (development):

```sh
openclaw plugins install ./native-memory-citations
```

Reload the Gateway after installing so the plugin host exposes the tools.

## Requirements

- Node.js 22.19.0 or newer.
- OpenClaw 2026.6.8 or newer (declared as a peer dependency).
- A local OpenClaw workspace containing text memory files.

Supported memory file types are `.md`, `.txt`, `.json`, `.jsonl`, `.yaml`, and
`.yml`. Files with other extensions are not scanned.

## Intended use

Native Memory Citations is intended for OpenClaw deployments where an agent needs
access to selected memory files without broad filesystem visibility. It suits
single-user, team, and shared environments in which private memory, project notes,
identity files, and tool references must be handled within clear boundaries.

## Tools

- `native_memory_search` - search the approved roots and return snippets with source paths, line numbers, and file SHA-256 hashes.
- `native_memory_fetch` - fetch a cited source by `sourceId` or a safe path, optionally checking an expected citation hash.
- `native_memory_answer` - build an extractive answer from cited snippets, and state plainly when no cited memory is found.

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
bounded-mode plugin reads existing memory files only; it does not create, modify, or
delete them. Enhanced mode can write only its own derived sidecars when explicitly
enabled.
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

## Enhanced mode (opt-in)

Enhanced mode layers the three pillars of agentic memory - storage, injection, and
recall - on top of the bounded core, while reusing the same access boundary,
redaction, and citation guarantees. It is opt-in and default-off: setting
`mode: "enhanced"` turns on the framework, and each pillar is then enabled
individually. Doing nothing leaves the plugin in bounded mode.

> **Enhanced-mode privacy & control.** Enhanced mode is opt-in and default-off. When
> you enable its individual features, it can write local sidecars
> (`memory/graph.jsonl` and a session snapshot), inject redacted memory snapshot
> content into the model prompt, and depend on OpenClaw `memory-core` dreaming.
> Sidecar writes and injection are redacted, retained locally, and size-bounded, but
> redaction remains defense-in-depth rather than access control.
> Disable these surfaces with `graph.enabled: false`, `observations.enabled: false`,
> `injection.enabled: false`, and `recall.snapshotFirst: false`. The plugin never
> changes host config and no longer brokers approvals; if host dreaming is off, it
> tells the operator to set `plugins.entries.memory-core.config.dreaming.enabled`
> themselves and degrades dreaming-dependent features.

> **Availability (2026.6.11).** Enhanced mode is delivered incrementally. This release
> ships the bounded-mode guardrails, the enhanced config schema, plugin health checks,
> the deterministic zero-LLM knowledge-graph sidecar, and the enhanced lifecycle
> scaffolding. Enhanced snapshot and graph reads reuse the same access boundary as
> bounded tools. Observation logging is deferred until structured extraction ships.
> The richer recall, model-based, and wiki pillars - and full runtime dispatch/soak
> validation of the lifecycle hooks - are still pending (see Forthcoming).
> On any version, an unset or default configuration behaves exactly as bounded mode.

### What 2026.6.11 ships

- **Bounded mode (default)** - unchanged guardrails and behavior (everything above).
- **Enhanced config schema + plugin health checks** - all enhanced keys are
 schema-declared (so `openclaw doctor --fix` will not prune them), and the plugin
 registers health checks visible to `openclaw doctor`.
- **Knowledge graph, zero-LLM** (`graph.enabled`). `native_memory_extract` writes typed
 entity links (for example `works_at`, `invested_in`, `founded`) from your authorized
 memory files into `memory/graph.jsonl` with no model call; `native_memory_graph`
 queries it with a hard depth cap and cycle prevention. This pillar is functional in
 this release. Extraction uses the same `allowedRoots`, `sharedMode`, hidden-path,
 symlink/realpath, text-only, and `maxFileBytes` boundary as bounded search/fetch.
- **Enhanced lifecycle scaffolding** (`injection.enabled`, `observations.enabled`,
 `recall.snapshotFirst`). The code paths are present: `session_start` writes a capped
 session snapshot from authorized `MEMORY.md`/`DREAMS.md` only when those files pass
 the access boundary, and `before_prompt_build` injects it. `agent_end` currently
 emits a one-time notice and does not write raw observation records; observation
 logging resumes only when structured extraction ships. On external-CLI runners or
 any other harness where in-process lifecycle hooks do not dispatch, these
 hook-dependent features degrade cleanly: the turn is unaffected and the three core
 cited-memory tools still work. **Runtime hook dispatch and soak validation are still
 pending - treat these as experimental until validated on the embedded runner.**

### Forthcoming (not in 2026.6.9)

- Semantic recall fusion through the host `memory_search`, RRF reranking, intent
 classification, and snapshot-first recall inside `native_memory_search` /
 `native_memory_answer`.
- Model-based structured observation extraction and its fail-open-under-slow-model
 validation. Until that ships, `observations.enabled` emits a one-time notice and
 writes no raw conversation-derived sidecar. When extraction ships, the default will
 use the host's configured summarization/fast model, not a provider-specific model
 name.
- The `memory-wiki` bridge.
- External gateway-perf, package-gauntlet, and long-soak validation lanes.

### Dreaming requirement

Enhanced mode builds on OpenClaw's built-in dream cycle (Light -> REM -> Deep
consolidation), which is **off by default in OpenClaw**. When you enable enhanced
mode and dreaming is off, the plugin logs an operator instruction to set
`plugins.entries.memory-core.config.dreaming.enabled` and degrades
dreaming-dependent enhanced features. It does not request approval, persist consent,
or mutate host configuration under any setting. Bounded mode never touches the
dreaming setting.

### Configuration (enhanced keys)

All keys default off/false; an absent block means bounded mode. Every key is part of
the plugin schema, so `openclaw doctor --fix` will not prune it. Keys for forthcoming
pillars - `recall.semantic`, `recall.rerank`, `recall.intentClassifier`,
`observations.model` and model-based `observations.extraction`, and `wikiBridge.enabled`
- are accepted by the schema but have no effect until those pillars ship. Omit
`observations.model` to use the host's configured summarization/fast model when
model-based extraction is implemented. Until structured extraction is implemented,
observation tagging writes nothing and logs a one-time notice.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | string | `"bounded"` | `"bounded"` or `"enhanced"`. |
| `graph.enabled` | boolean | `false` | Enable knowledge-graph extraction and the graph tools. |
| `graph.edgeTypes` | string[] | built-in set | Typed edges to extract. |
| `graph.maxDepth` | number | `3` | Hard cap on multi-hop traversal depth. |
| `recall.semantic` | boolean | `false` | Add semantic retrieval to search/answer. |
| `recall.rerank` | boolean | `false` | Rerank retrieved results by relevance. |
| `recall.snapshotFirst` | boolean | `false` | Check the session snapshot before deeper search. |
| `recall.intentClassifier` | boolean | `false` | Classify query intent to steer retrieval. |
| `injection.enabled` | boolean | `false` | Inject a capped session snapshot into context. |
| `injection.tokenCap` | number | `1300` | Maximum tokens injected per session. |
| `observations.enabled` | boolean | `false` | Reserve per-turn observation tagging for the future structured-extraction release; no raw sidecar is written today. |
| `observations.model` | string | host default | Optional model profile for future extraction; when omitted, use the host's configured summarization/fast model. |
| `observations.extraction` | boolean | `true` | Reserved for the future structured-extraction release; raw observation persistence is disabled. |
| `observations.maxBytes` | number | `1048576` | Reserved retention cap for the future structured observation sidecar. |
| `dreaming.notify` | boolean | `true` | Warn with the host config path when dreaming is disabled in enhanced mode. |
| `wikiBridge.enabled` | boolean | `false` | Enrich a separately installed `memory-wiki` vault, if present. |

### Compatibility

Enhanced mode requires a newer OpenClaw floor than bounded mode; the package declares
the required version per release. Hook-dependent features require a host harness that
dispatches in-process lifecycle hooks; external CLI runners and other non-dispatching
harnesses keep the core tools working and simply do not run those enhanced hooks.

## Security model

The plugin enforces a two-layer model.

`activation.onStartup` registers the bounded, read-only tools with OpenClaw. Tool
registration is not memory access: in bounded/default mode the plugin reads no
memory until `native_memory_search`, `native_memory_fetch`, or `native_memory_answer`
is explicitly invoked.

The access boundary determines what may be read. `allowedRoots` is trusted operator
configuration. Any caller-supplied fetch path, and any symlink that would escape a
root, is treated as untrusted and re-checked with `realpath`. Symlinks encountered
while walking directories during search are skipped. Fetch additionally rejects
hidden path segments, non-text files, and files larger than `maxFileBytes`.

Redaction is applied to all returned text as defense-in-depth. Named secret patterns
provide readable labels for common formats; a high-entropy backstop masks unknown
long tokens. Redaction is not an authorization or access-control boundary. It does
not modify source memory files, and it does not affect citation hashes, which are
computed from the original file text.

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
