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

### Redaction (defense-in-depth)

- All returned text — search snippets, fetched content, and extractive answers — is
  redacted before it leaves the plugin.
- Named secret patterns provide readable labels for common formats (for example API
  keys, bearer tokens and JWTs, credential URLs, and private key blocks). A
  high-entropy backstop masks unknown long tokens.
- Redaction is **not** an authorization or access-control boundary. It lowers the
  chance of returning a secret that happens to sit inside an authorized file; it
  does not decide what may be read.
- Redaction does not modify source files and does not affect citation hashes, which
  are computed from the original file text.

### Citation integrity

Full-file SHA-256 hashes accompany results so callers can detect when a previous
path-and-line citation may now point at changed content.

## Reporting a vulnerability

Please report suspected security issues through GitHub private vulnerability
reporting for this repository rather than in a public issue or pull request.

Until a fix is released, please do not disclose the issue publicly.
