# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## 2026.6.11

- Security: routes enhanced snapshot and graph reads through the same access
  boundary as the bounded tools. Enhanced reads now honor `allowedRoots`,
  `sharedMode`, hidden-path rejection, symlink/realpath checks, text-only filtering,
  and `maxFileBytes`; `native_memory_extract` still excludes derived sidecars during
  graph rebuilds.
- Security: removes the host-config mutation and approval-brokering capability from
  the enhanced dreaming guard. The plugin no longer calls gateway approval APIs,
  persists dreaming consent, accepts `dreaming.autoEnable`, or writes host config.
  When host dreaming is off, enhanced mode logs an operator instruction for
  `plugins.entries.memory-core.config.dreaming.enabled` and degrades.
- Security: defers observation logging until structured extraction ships. With
  `observations.enabled: true`, the plugin emits a one-time notice and does not
  create or append `memory/observations.jsonl`.
- Docs/build: synchronizes the generated manifest description with package metadata
  and clarifies that startup activation registers bounded, read-only tools but does
  not access memory until a tool or enabled enhanced hook runs.
- Preserved bounded mode behavior: no writes, no hooks, no injection, no approval
  requests, no host dreaming mutation, and unchanged cited search/fetch/answer tools.

## 2026.6.10

- Security: redacts enhanced-mode observation writes, session snapshot writes, and
  snapshot prompt injection with the same defense-in-depth redaction path used by
  cited tool outputs.
- Security: replaces silent enhanced-mode host dreaming mutation with explicit
  consent. The default no longer mutates host config; it requests plugin approval
  when available, degrades safely on deny/timeout/no approval route, and treats
  `dreaming.autoEnable: true` as an explicit pre-authorization escape hatch.
- Docs: adds enhanced-mode privacy and control disclosures to README and SECURITY.
- Preserved bounded mode behavior: no writes, no hooks, no injection, no approval
  requests, and no host dreaming mutation in bounded/default mode.

## 2026.6.9

- Preserved bounded mode as the default behavior: read-only, keyword/substring search,
  extractive cited answers, no network/model calls, no host config mutation, and no
  hook registration unless enhanced mode is explicitly enabled.
- Added complete default-off enhanced-mode config schema so `openclaw doctor --fix`
  does not prune the new keys.
- Added plugin health checks for manifest tool coverage, enhanced-mode dreaming
  state, and graph sidecar freshness.
- Added optional `native_memory_graph` and `native_memory_extract` tools for the
  functional deterministic zero-LLM knowledge graph sidecar. `native_memory_extract`
  writes `memory/graph.jsonl` only when `mode: "enhanced"` and `graph.enabled: true`;
  `native_memory_graph` queries it with a depth cap and cycle prevention.
- Added enhanced lifecycle scaffolding for the dreaming guard, session snapshot
  refresh, opt-in prompt injection, and fail-open observation appends. Runtime hook
  dispatch/soak validation on the embedded runner is still pending.
- Added `observations.maxBytes` to bound the enhanced observation append sidecar and
  made graph extraction ignore plugin-derived sidecars during rebuilds.
- Made enhanced lifecycle documentation and tests provider-neutral: non-dispatching
  external runners leave hook-dependent behavior inactive while the three core tools
  continue to work.
- Added regression coverage for bounded-mode no-side-effect invariants, graph
  extraction inertness, depth-capped/cycle-safe graph traversal, and enhanced hook
  registration.
- Raised the enhanced release compatibility floor to OpenClaw plugin API/gateway
  `2026.6.8` and peer dependency `openclaw >=2026.6.8`.
- Docs: documented bounded vs enhanced operating modes and clearly marked which
  enhanced capabilities ship in 2026.6.9 versus forthcoming.
- Forthcoming after 2026.6.9: semantic recall fusion through host `memory_search`,
  RRF/rerank, intent classification, snapshot-first recall inside
  `native_memory_search`/`native_memory_answer`, model-agnostic observation extraction
  through the host's configured summarization/fast model,
  fail-open-under-slow-model proof, the memory-wiki bridge, and external
  gateway-perf/package-gauntlet/long-soak validation lanes.

## 2026.6.8

- Correct packaging metadata: lower `openclaw.compat.pluginApi` floor to `>=2026.5.17`,
  add `openclaw.compat.minGatewayVersion`, add `openclaw.build.pluginSdkVersion`, and stamp
  `openclaw.build.openclawVersion`/`pluginSdkVersion` from the actual build host in CI.
- No runtime or behavior change vs 2026.6.6/2026.6.7.

## 2026.6.7 (superseded - do not use)

- Added OpenClaw `compat`/`build` metadata, but shipped with an incorrect compat floor
  (`>=2026.6.1`, excluding 2026.5.17-2026.6.0 hosts), a missing `minGatewayVersion`,
  a missing `build.pluginSdkVersion`, and an untruthful `build.openclawVersion` (`2026.6.8`).
  Deprecated on npm; superseded by 2026.6.8. No runtime impact.

## 2026.6.6

- Build: make the package repository URL exactly match the GitHub repository URL used by npm trusted publishing.
- Build: update release workflow actions to the current Node 24-compatible major versions.
- No functional changes.

## 2026.6.5

- Build: restore npm registry setup in the release workflow so npm CLI can detect the GitHub Actions OIDC publish environment, while still setting no npm auth token.
- No functional changes.

## 2026.6.4

- Build: remove `setup-node` npm registry configuration while diagnosing the trusted-publishing auth path.
- Release: corrective publish after the `v2026.6.3` workflow reached npm publish but failed the package upload permission check.
- No functional changes.

## 2026.6.3

- Build: publish via npm trusted publishing (OIDC) from GitHub Actions; provenance attestations enabled.
- No functional changes.

## 2026.6.2

- Docs: added a Requirements section (Node, OpenClaw peer dependency, supported memory file types).
- Docs: converted README links to SECURITY.md, CONTRIBUTING.md, CHANGELOG.md, and LICENSE to absolute GitHub URLs so they resolve on the npm page.
- Docs: moved the Install section higher in the README.
- No functional changes.

## 2026.6.1

- Docs: point the README architecture diagram at the `master` branch so it no longer references an old release tag and needs no per-release updates.
- No functional changes.

## 2026.6.0

- Versioning: adopted calendar versioning (YEAR.MONTH.MICRO) to match OpenClaw, migrating from the 0.x line. See CONTRIBUTING.md.
- Chore: ignore .npmrc to prevent committing npm credentials.
- No functional changes.

## 0.1.4

- Documentation: rewrote the README as a public-facing project description.
- Documentation: moved build, validation, and release procedure to CONTRIBUTING.md.
- Documentation: added SECURITY.md with the security model and GitHub private vulnerability reporting path.
- No functional changes.

## 0.1.3

- Documentation: use an absolute GitHub image URL so the architecture diagram renders on npm.
- No functional changes.

## 0.1.2

- Documentation: added architecture diagram.
- Documentation: added a complete configuration reference (keys, defaults, examples, and constraints).
- No functional changes.

## 0.1.1

- Docs: Install section now leads with the npm install command.
- Docs: replaced the stale "Publish" section with current "Releasing" steps.
- No functional changes.

### Added
- Added full-file SHA-256 hashes to search hits and fetch results so callers can
  snapshot citation integrity.
- Added optional `expectedSha256` support to `native_memory_fetch`; mismatched
  hashes return a stale-citation warning on the fetch result.
- Added output redaction for common secret patterns across search snippets,
  match lines, fetched content, and extractive answers.
- Expanded single-line redaction coverage for Azure keys/SAS signatures, AWS
  access key ids, Slack tokens, Google API keys, JWTs, and credential URLs.
- Added a high-entropy token redaction backstop for unknown long secret formats.

### Fixed
- Normalized non-finite `native_memory_fetch` `lineStart` and `lineEnd` values
  to finite clamped line ranges.
- Fixed line-range fetch and zero-context search leakage for multi-line
  private-key blocks by using full-file, line-preserving redaction before output
  selection.
- Separated raw relevance scoring and answer confidence from redacted public
  output, so redacted values can still support recall without leaking.
- Rejected unsafe custom `allowedRoots` values including empty entries, `.`,
  `..`, paths containing `..`, absolute paths, and hidden path segments.
- Normalized non-finite `maxFileBytes` values to the default cap.
- Filtered `native_memory_answer` citations to hits that support the required
  matched-term threshold.
- Hardened `native_memory_fetch` so direct fetches cannot bypass search policy
  for hidden files/directories, non-text files, or files larger than
  `maxFileBytes`.
- Capped excessive `maxChars` requests and normalized non-finite fetch limits.
- Tightened `native_memory_answer` confidence so a query whose required terms
  are split across separate files returns `known: false` unless one cited hit
  supports enough terms.

## [0.1.0] - 2026-06-17

First working release. Provides three agent tools — `native_memory_search`,
`native_memory_fetch`, and `native_memory_answer` — that search, retrieve, and
answer from approved local OpenClaw memory roots with source citations.

### Added
- Declared `configSchema` (`workspace`, `allowedRoots`, `sharedMode`,
  `maxFileBytes`), generated into the manifest via `openclaw plugins build`.
- `matchLine` / `matchText` on search hits; answers cite the strongest matching
  line within a region rather than the region start.
- mtime/size-keyed line cache with an LRU cap, bounded scan concurrency, and
  `AbortSignal` threading through search, answer, and the tool entry handlers.
- Stopword stripping and word-boundary matching for short query tokens.
- Debug logging for scan/hit counts; warn logging for oversized-file and
  symlink skips.
- Regression coverage for path safety, config plumbing, region merging, the
  answer confidence gate, fetch clamping, the cache, and the manifest contract.

### Fixed
- Plugin config now reaches tool execution. The tool `execute` signature uses
  `(params, config, context)`; config is no longer silently discarded.
- `native_memory_fetch` is symlink-safe: a link inside an allowed root that
  points outside is rejected on a `realpath` containment re-check.
- Default workspace resolves from `$OPENCLAW_WORKSPACE` then
  `~/.openclaw/workspace` instead of a hardcoded path.
- Search no longer emits overlapping per-line hits; adjacent matches merge into
  a single scored region.
- `native_memory_answer` reports `known: false` instead of citing a coincidental
  keyword hit, gated on a minimum score and distinct-term coverage.

### Security
- Trust model: `allowedRoots` is operator configuration and is trusted;
  anything reached by following a symlink out of a root, or supplied by a
  caller to fetch, is untrusted and re-checked against real roots. Symlinks
  encountered while walking directories during search are skipped.
