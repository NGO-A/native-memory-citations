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

Set `sharedMode: true` in plugin config to exclude private `MEMORY.md` by default.

## Build And Validate

```bash
npm install
npm test
npm run build
npm run plugin:validate
```

## Config

```json
{
  "workspace": "/home/ad/.openclaw/workspace",
  "allowedRoots": ["memory", "USER.md", "TOOLS.md"],
  "sharedMode": true,
  "maxFileBytes": 1048576
}
```

## Notes

This v1 is intentionally local-file based. It is portable and dependency-light. A future version can add vector search while keeping the same public tool names.
