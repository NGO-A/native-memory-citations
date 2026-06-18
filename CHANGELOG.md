# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
