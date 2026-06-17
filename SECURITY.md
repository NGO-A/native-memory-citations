# Security Policy

## Supported versions

The latest published `0.1.x` release receives security fixes.

## Trust model

This plugin reads local files under operator-configured memory roots. Its
boundary is defined as follows:

- **`allowedRoots` is trusted.** It is operator configuration. A root that is
  itself a symlink is followed.
- **Anything reached by following a symlink *out of* a root is untrusted.** A
  link planted inside a root that points outside the allowed roots is rejected.
  `native_memory_fetch` resolves caller-supplied paths with `realpath` and
  re-checks containment against the real roots before reading.
- **Symlinks encountered while walking directories during search are skipped**,
  so search will not surface content reached through a link.
- **Fetch applies the same visible text-file boundary as search.** Hidden path
  segments such as `memory/.env` and `memory/.dreams/events.jsonl` are rejected,
  and non-text extensions are rejected.
- Files larger than `maxFileBytes` (default 1 MiB) are skipped. Per-line and
  per-snippet output is length-capped.
- Search and fetch results include a full-file SHA-256 hash. Callers can pass a
  prior hash as `expectedSha256` to `native_memory_fetch`; if the file changed,
  fetch marks the result stale so agents do not silently trust an old line
  citation against new content.

This plugin does not transmit memory contents anywhere; it only returns cited
snippets to the calling agent. It performs no network I/O.

## Reporting a vulnerability

Report suspected vulnerabilities through the repository's private security
advisory channel (GitHub → Security → Report a vulnerability) rather than a
public issue. Include the affected version, a reproduction, and the observed vs.
expected containment behavior.
