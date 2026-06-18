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

## Versioning

This project uses calendar versioning to match OpenClaw: `YEAR.MONTH.MICRO`.

- `YEAR` is the full year, for example `2026`.
- `MONTH` is the month number with no leading zero (`1` through `12`; June is `6`,
  not `06`). Leading zeros are invalid under semantic versioning and are rejected by
  npm.
- `MICRO` is a release counter within a given year and month. It starts at `0`,
  increments by one per published release, and resets to `0` whenever the year or
  month changes.
- Pre-releases use a semantic-version suffix, for example `2026.6.0-beta.1`, which
  sorts before the corresponding release. This mirrors OpenClaw's `-beta.N`
  convention.

Because the version encodes the release date and sequence rather than the kind of
change, it does not by itself indicate whether a release is breaking. Compatibility
and notable changes are recorded in `CHANGELOG.md`.

The project moved from `0.x` semantic versioning to calendar versioning at
`2026.6.0`. This change is one-directional: every subsequent version sorts above
`2026.6.0`.

## Releasing

The package is published to npm as `@ngo-a/native-memory-citations`.

To cut a release:

1. Confirm the suite is green: `npm test`.
2. Set the version in `package.json` according to the scheme above:
   - If the current year and month are unchanged since the last release, increment
     `MICRO` (for example `2026.6.0` to `2026.6.1`; `npm version patch` does this).
   - If the year or month has changed, set the version explicitly to
     `<year>.<month>.0` (for example `npm version 2026.7.0`). Do not rely on
     `npm version minor` or `npm version major`; they do not track the calendar.
3. Regenerate the manifest and confirm it is in sync: `npm run plugin:build`, then
   `npm run plugin:build:check`.
4. `npm publish`.

The `prepublishOnly` script rebuilds `dist/` first, and `publishConfig.access` is
`public`, so no extra flags are required. A published version cannot be overwritten;
fixes ship as a new version.

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
