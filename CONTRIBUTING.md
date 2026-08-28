# Contributing

Thanks for looking at this. Two things are worth knowing before you start, both
of which cost a contributor real time in August 2026.

## This repo is a mirror, and it used to go stale

`free-pi-cli` is developed in a private monorepo alongside the server, and
mirrored here. From 2026-08-17 to 2026-08-28 that mirror was manual, and it
stopped happening: this repo sat at 0.2.1 with a single commit while npm shipped
through 0.2.8. Seven releases, no public source, no tags.

Someone filed five good PRs against that stale snapshot and had to describe the
bugs by npm version number, because the repo could not tell them what was
actually running. They got lucky — the bugs were still there — but that was
luck, not process.

The mirror is now automatic and runs on every release, so `main` here matches
the published version. If it ever does not, that is a bug worth reporting on its
own.

## What this means for your PR

**PRs are welcome and they land here first.** Open against `main` as normal. Your
commits stay yours — merges here are real merges, not squashes into someone
else's name.

**Merged changes are then ported into the private monorepo by a maintainer.**
That port is the maintainer's job, not yours. You do not need access to anything
private, and you should not have to think about it.

**A release may rewrite files your PR touched.** The mirror overwrites `src/`,
`test/`, `README.md` and `CHANGELOG.md` from the monorepo. If a change is merged
here but not yet ported, the next release will revert it. Maintainers: port
before releasing. This is the one sharp edge of the arrangement and the reason
the port is a release-blocking step rather than a nice-to-have.

## Layout

```
src/            the CLI
src/vendor/     copies of two internal packages the CLI depends on
test/           tests
```

`src/vendor/shared` and `src/vendor/pi-ads` are mirrored from the monorepo and
resolved through the `@freepi/*` aliases in `tsconfig.json`. Edit them if a fix
genuinely belongs there — just say so in the PR, because those files need a
maintainer to carry the change back by hand.

Two files under `src/vendor/shared` are deliberately **not** copies:
`config.ts` and `index.ts`. The private originals carry server-owned spend caps,
account tiers and rate ceilings, which do not ship in a client. `config.ts` here
is a hand-written client-only rewrite with the two ad display knobs and nothing
else.

## Working on it

```bash
bun install
bun test
bun run typecheck
bun run build
```

CI runs tests and typecheck on ubuntu, macos and windows. The Windows leg is not
decoration — two of the five PRs in August fixed Windows-only bugs that had
shipped in every release, and the reason nobody caught them is that nothing had
ever run there. If you touch process spawning, path handling, or TTY detection,
watch that leg.

## What gets a quick yes

- A bug fix with a test that fails without it.
- A platform fix, especially Windows.
- Tests for something currently untested.

## What needs a conversation first

- New dependencies. The tree is deliberately tiny.
- Anything touching the consent flow, credential storage, or the ad boundary.
  Consent covers ads *and* training on sessions; it must never become something
  a pipe or a flag can satisfy on the user's behalf.
