# Contributing

## Development setup

Install dependencies and run the test suite:

```
npm install
npm test
```

The test suite covers the access boundary, the redaction invariants, and
citation-hash behavior. Keep it green before opening a pull request.

## Generated manifest

`openclaw.plugin.json` is generated from the `defineToolPlugin` metadata in
`src/index.ts`. Do not edit it by hand. After changing the plugin id, name,
description, configuration schema, or any tool name, regenerate and validate:

```
npm install
npm test
npm run plugin:build
npm run plugin:validate
```

In CI, fail on stale generated metadata without rewriting files:

```
npm run plugin:build:check
npm run plugin:validate
npm test
```

## Releasing

The package is published to npm as `@ngo-a/native-memory-citations`.

To cut a release:

1. Confirm the suite is green: `npm test`.
2. Bump `version` in `package.json` per semantic versioning.
3. `npm publish`.

The `prepublishOnly` script rebuilds `dist/` first, and `publishConfig.access` is
`public`, so no extra flags are required. A published version number cannot be
overwritten; fixes ship as a new version.

Publishing requires authentication as a member of the `@ngo-a` organization with
publish rights. Prefer an interactive `npm login`, or a short-lived scoped access
token that is removed immediately after the release, rather than a standing publish
token stored in the environment.

## Documentation-only releases

Changes to `README.md` appear on the npm package page only after a new version is
published. Repository-only assets — `CONTRIBUTING.md`, `SECURITY.md`, and the
diagram under `docs/` — are not included in the npm tarball and are visible only in
the GitHub repository. The package tarball is limited to `dist`, the generated
manifest, and `README.md`.
