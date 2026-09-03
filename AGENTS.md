# AGENTS.md

## This repo is a generated mirror

`free-pi-cli` is a one-way mirror of `packages/cli` (plus the vendored
`pi-ads` and `shared` packages) from the private `dennisonbertram/free-pi`
monorepo. A GitHub Actions workflow in that repo syncs this one on every push
to its `main` branch. `.mirror-state.json` records the sha256 of every file the
last sync wrote.

Rules for agents:

- Do not edit `src/`, `test/`, `README.md`, `CHANGELOG.md`, or `package.json`
  here. The next sync overwrites them and refuses to run if it finds hand
  edits. Port the change into the monorepo instead.
- Do not publish to npm from this repo. Publishing runs from the monorepo on a
  `cli-v<version>` tag.
- Outside contributors: open a PR here. A maintainer ports it into the
  monorepo, and the next sync brings it back.
- Keep this repo public and free of private repo names, secrets, and
  server-side spend or tier values. Three files in `shared` are held back from
  the mirror on purpose for that reason.

Split reviewed 2026-09-02: the CLI is a separate public repo because the
npm bundle already ships its source, and the monorepo stays private.
