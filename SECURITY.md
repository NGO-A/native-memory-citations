# Security

## Security model

Native Memory Citations enforces a two-layer model: an access boundary that
determines what may be read, and redaction applied to what is returned.

### Access boundary (authorization)

- `allowedRoots` is trusted operator configuration. It defines the only files and
  directories the plugin may read, resolved relative to the configured workspace.
- Any caller-supplied fetch path, and any symlink that would escape a root, is
  treated as untrusted and re-checked with `realpath` before content is read.
- Symlinks encountered while walking directories during search are skipped.
- Fetch rejects hidden path segments, non-text files, and files larger than
  `maxFileBytes`.
- `allowedRoots` entries that are empty, `.`, `..`, absolute, contain a `..`
  segment, or contain a hidden segment are rejected.
- Enhanced snapshot and graph reads use the same boundary as bounded search/fetch.
  No enhanced code path may read workspace memory by raw path join; unauthorized
  `MEMORY.md`, `DREAMS.md`, or graph source files are skipped.

### Redaction (defense-in-depth)

- All returned text — search snippets, fetched content, and extractive answers — is
  redacted before it leaves the plugin.
- In enhanced mode, session snapshot writes and snapshot prompt injection are
  redacted before they leave their source path. Observation logging is deferred until
  structured extraction ships.
- Named secret patterns provide readable labels for common formats (for example API
  keys, bearer tokens and JWTs, credential URLs, and private key blocks). A
  high-entropy backstop masks unknown long tokens.
- Redaction is **not** an authorization or access-control boundary. It lowers the
  chance of returning a secret that happens to sit inside an authorized file; it
  does not decide what may be read.
- Redaction does not modify source memory files and does not affect citation hashes,
  which are computed from the original file text.

### Citation integrity

Full-file SHA-256 hashes accompany results so callers can detect when a previous
path-and-line citation may now point at changed content.

## Operating modes and security posture

The plugin runs in `bounded` mode by default and in `enhanced` mode only when an
operator opts in. The two-layer model above applies in both modes; the surfaces each
mode exposes differ.

### Bounded mode (default)

Bounded mode is the behavior described in full above. It is read-only, makes no
network calls, makes no model calls, registers no hooks, and never changes host
configuration. These properties are enforced by regression tests that gate every
release: a bounded-mode install must perform no file writes, no network calls, no
model calls, and no hook registration, and must not modify the host dreaming setting.
A default upgrade therefore preserves the externally observable behavior of the prior
release.

The manifest uses `activation.onStartup` so OpenClaw can register the bounded,
read-only tools. Registration is not memory access: bounded/default mode reads no
memory until one of the cited-memory tools is explicitly invoked.

### Enhanced mode (opt-in)

Enhanced mode adds capabilities that introduce new surfaces. Each is off by default
and individually gated, and the access boundary, redaction, and full-file SHA-256
citation path are the same audited code in both modes.

- **Privacy and control.** Enhanced mode can write local sidecars
  (`memory/graph.jsonl` and a cached session snapshot) and can inject redacted memory
  snapshot content into the model prompt. These surfaces are opt-in, size-bounded,
  redacted, locally retained, and derived only from authorized memory files. Disable
  them with `graph.enabled: false`, `injection.enabled: false`, and
  `recall.snapshotFirst: false`. `observations.enabled` is accepted for forward
  compatibility but currently writes nothing until structured extraction ships.
- **Local writes.** The knowledge-graph and snapshot features write derived files
  (`memory/graph.jsonl` and a cached session snapshot)
  inside the workspace. They are derived from already-authorized memory files, are
  size-bounded, and never overwrite your source memory files (`MEMORY.md`, daily notes,
  `DREAMS.md`). These derived files are excluded from retrieval and citation, so
  machine-generated content never feeds back into what the plugin returns or cites.
  Graph extraction uses no model.
- **Structured observations deferred.** Observation tagging will resume only when
  structured extraction ships. In this release, the hook emits a one-time notice and
  does not create or append `memory/observations.jsonl`; no raw conversation-derived
  fallback is persisted.
- **Context injection.** Snapshot injection adds capped memory to the model's context
  through a prompt-build hook. It requires the host to explicitly allow prompt
  injection for this plugin and does not run under the `claude-cli` provider.
- **Host configuration.** Enhanced mode depends on OpenClaw's dream cycle and will
  warn when it is disabled, naming
  `plugins.entries.memory-core.config.dreaming.enabled` as the operator-owned setting
  to change. The plugin does not request approvals, persist consent, or mutate host
  configuration under any setting. Bounded mode never requests approval or changes
  dreaming.

Enhanced retrieval answers remain subject to the same access boundary, redaction, and
citation guarantees as bounded answers.

## Reporting a vulnerability

Report suspected vulnerabilities privately through GitHub's private vulnerability
reporting: open the repository's **Security** tab and use **Report a vulnerability**
(GitHub Security Advisories). Reports stay private to the maintainers — there is no
email address to expose or monitor, and reporting requires a GitHub account.

Do not open a public issue or pull request that discloses an unpatched vulnerability,
exploit path, or secret. Public disclosures may be closed or hidden and redirected to
the private process so the issue can be fixed before it becomes an attack recipe.
Please keep the issue private until a fix is released.

This is a best-effort open-source project with no paid bug bounty. High-signal
reports — and, where practical, a focused fix — are the most useful contribution.

### Scope and trust model

The plugin is read-only by default and is built for a trusted operator who controls
which workspace files it may read. Reports are evaluated against that access boundary.
The following are by design and are **not**, on their own, vulnerabilities:

- **A redaction miss.** Redaction is defense-in-depth, not an access-control boundary.
  A secret returned from a file the operator authorized is a redaction gap to harden,
  not a boundary bypass.
- **Operator configuration.** Granting `allowedRoots` access to files that were not
  intended, or disabling protections, is configuration — not a plugin flaw.
- **Opt-in enhanced-mode behavior** the operator explicitly enabled (knowledge graph,
  injection, observation tagging, dreaming) behaving as documented.
- **Scanner-only or dependency-only findings** without a working reproduction that
  demonstrates impact against this plugin.

A genuine vulnerability is reading or returning content **outside** the configured
`allowedRoots` — for example a symlink, `..`, or path-traversal escape, a
hidden-segment or non-text bypass of the fetch checks, or a defeat of the workspace
resolution — shown with a concrete reproduction.

### What a useful report contains

- The exact path: file, function, and line range on a current revision.
- A tested, minimal reproduction (the configuration plus the call that crosses the boundary).
- The demonstrated impact: what was read or returned that should not have been.
- Remediation advice, if you have it.

Reports without a reproduction and demonstrated impact are deprioritized.
