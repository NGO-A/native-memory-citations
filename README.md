# Native Memory Citations

Native OpenClaw plugin for cited local memory search and retrieval.

## Tools

- `native_memory_search`: search approved memory roots and return snippets with source paths and line numbers.
- `native_memory_fetch`: fetch a cited source by `sourceId` or safe path.
- `native_memory_answer`: build an extractive answer from cited memory snippets; says when no cited memory is found.

## Default Scope

By default, the plugin searches:

- `memory/`
- `MEMORY.md`
- `USER.md`
- `IDENTITY.md`
- `TOOLS.md`

Set `sharedMode: true` in plugin config to exclude the private `MEMORY.md` from
the default root set. Setting `allowedRoots` explicitly overrides the default
set entirely and supersedes `sharedMode`.

## Build, Generate, Validate

The manifest (`openclaw.plugin.json`) is generated from the `defineToolPlugin`
metadata in `src/index.ts`. Do not hand-edit it; regenerate after changing the
plugin id, name, description, `configSchema`, or any tool name:

```bash
npm install
npm test
npm run plugin:build
npm run plugin:validate
```

In CI, fail on stale generated metadata without rewriting files:

```bash
npm run plugin:build:check
npm run plugin:validate
npm test
```

## Config

Plugin config is read from the plugin's entry in the OpenClaw Gateway config.
All keys are optional:

```json
{
  "workspace": "/home/ad/.openclaw/workspace",
  "allowedRoots": ["memory", "USER.md", "TOOLS.md"],
  "sharedMode": true,
  "maxFileBytes": 1048576
}
```

If `workspace` is omitted, the plugin uses `$OPENCLAW_WORKSPACE`, then
`~/.openclaw/workspace`. There is no hardcoded user-specific default.

## Security Model

- `allowedRoots` is operator configuration and is trusted. A symlinked root is followed.
- Anything reached by following a symlink out of a root, and any caller-supplied path passed to `native_memory_fetch`, is untrusted. Such targets are resolved with `realpath` and re-checked for containment, so a link planted inside `memory/` that points outside the allowed roots is rejected.
- Symlinks discovered while walking a directory during search are skipped.

## Notes

This v1 is intentionally local-file based. It is portable and dependency-light.
A future version can add vector search while keeping the same public tool names.
Search is keyword/substring based and re-reads the corpus on each query; for
large memory trees a future version should add an index/cache and honor
`context.signal` for mid-search cancellation.
