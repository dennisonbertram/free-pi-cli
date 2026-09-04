# free-pi-cli

A preconfigured [pi](https://github.com/earendil-works/pi) coding agent, free
for the user because ads pay for inference. All model calls route through the
free-pi proxy — you never handle a model API key.

```
npx --no-audit free-pi-cli
```

First run shows a consent screen (free inference, ads pay for it, sessions
may be used to train models), then signs you in with GitHub. Config and the
signed-in token live under `~/.free-pi/agent`, kept separate from any
existing `~/.pi/agent` install.

## Running it again

Closed the terminal? Just run the same command again — you stay signed in:

```
npx --no-audit free-pi-cli
```

Prefer a shorter command? Install it once, globally, then call it by name:

```
npm install -g free-pi-cli
free-pi-cli
```

Note: `free-pi-cli` is the command — **not** `pi`. If you see the built-in
agent suggest `pi --session …` on exit, use the `free-pi-cli` form of the
same thing: `npx free-pi-cli --session <id>` resumes that session (the id
prints when you exit), and plain `npx free-pi-cli` starts a fresh one.

## Commands

```
free-pi-cli                 start the coding agent
free-pi-cli --session <id>  resume a previous session (the id prints when you exit)
free-pi-cli logout          remove the stored sign-in token; the next run signs in again
free-pi-cli --version       print the CLI version
free-pi-cli --help          usage
```

`logout` is purely local: it deletes `~/.free-pi/agent/credentials.json` and
never contacts the server — there is no revoke endpoint, so the signed-in
token itself stays valid server-side until it expires. It also works offline.

Inside a session, free-pi adds a few slash commands on top of pi's own:
`/model` picks between models when the server offers more than one,
`/whats-new` shows the changelog for the running version, `/update` triggers
a self-update, and `/close-other-session` frees your account's session slot
if another terminal holds it.

## Development

- `FREEPI_BASE_URL` overrides the backend base URL (default
  `https://api.freepi.ai`) — point it at a local dev server.
- `bun test` runs the test suite against an in-process stub server; no real
  network or real pi TUI involved.

## Layout

| File | Purpose |
|---|---|
| `src/index.ts` | bin entry — wires real dependencies, calls `run()` |
| `src/run.ts` | orchestration: consent → login → token check → launch |
| `src/consent.ts` | consent screen text/parsing |
| `src/auth-flow.ts` | GitHub device flow client (`/auth/github/device`, `/auth/consent`, `/auth/token`), `/me` token check |
| `src/credentials.ts` | JWT file storage (mode 0600) under the free-pi config dir |
| `src/provider.ts` | pure builder for the `pi.registerProvider` config |
| `src/pi-launch.ts` | the actual pi SDK integration (registers the provider, launches the TUI) |
| `src/paths.ts` | free-pi-namespaced config dir, isolated from `~/.pi/agent` |
