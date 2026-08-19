# free-pi-cli

A preconfigured [pi](https://github.com/earendil-works/pi) coding agent that is
free to use because ads pay for the inference. Every model call routes through
the free-pi proxy, so you never handle a model API key.

```
npx free-pi-cli
```

First run shows a consent screen (free inference, ads pay for it, sessions may
be used to train models), then signs you in with GitHub. Your config and
signed-in token live under `~/.free-pi/agent`, kept separate from any existing
`~/.pi/agent` install.

> **Early access.** free-pi is an experiment, not a finished product. Expect
> rough edges and changes. See [freepi.ai](https://freepi.ai) for status.

## Commands

```
free-pi-cli            start the coding agent
free-pi-cli logout     remove the stored sign-in token; the next run signs in again
free-pi-cli --version  print the CLI version
free-pi-cli --help     usage
```

`logout` is purely local (it deletes `~/.free-pi/agent/credentials.json` and
never contacts the server), so it also works offline.

## The one hard promise: ad content never enters the model's context

Ads are shown in your terminal, next to the chat — never inside it. Ad copy is
never added to a prompt, a message, or anything the model sees. The extension
that draws the ads registers **only** UI-lifecycle hooks (`session_start`,
`turn_end`, `session_shutdown`); it registers no hook that could splice content
into a model request, and it never calls any message- or tool-surface API.

This is not a claim you have to take on trust. It is enforced by a test that
gates every release:

```
bun test src/vendor/pi-ads/sandbox.test.ts
```

The test proves two things: the extension's registered hook surface contains
only those three UI hooks, and a request payload driven through the extension's
own handlers comes out byte-identical to the original — a distinctive marker
planted in a live ad never appears in it. If that ever stops being true, the
test fails and the build does not ship.

## What is in this repository

This is the **client** for free-pi: the `npx free-pi-cli` command and the
terminal ad extension. It is fully open. The free-pi **server** — the proxy,
billing, and abuse-control logic — is a separate, private codebase; nothing in
it is required to read, build, or audit the client here.

| Path | Purpose |
|---|---|
| `src/index.ts` | bin entry — wires real dependencies and calls `run()` |
| `src/run.ts` | orchestration: consent -> login -> token check -> launch |
| `src/consent.ts` | consent screen text and parsing |
| `src/auth-flow.ts` | GitHub device-flow client and `/me` token check |
| `src/provider.ts` | builder for the `pi.registerProvider` config |
| `src/pi-launch.ts` | pi SDK integration: registers the provider and the ad extension, launches the TUI |
| `src/vendor/pi-ads/` | the terminal ad extension (rendering, fetch, sandbox test) |
| `src/vendor/shared/` | the client half of the free-pi API contract (schemas, error codes) |

## Build and test

Requires [Bun](https://bun.sh).

```
bun install
bun run build   # -> dist/index.js (the published bin)
bun test        # includes the ad-sandbox release gate
```

`FREEPI_BASE_URL` overrides the backend base URL (default
`https://api.freepi.ai`) — point it at a local dev server.

## License

MIT — see [LICENSE](./LICENSE). Copyright (c) 2026 DappHero Corp / Dennison
Bertram.
