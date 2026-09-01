# Changelog

All notable changes to `free-pi-cli`. Format based on [Keep a Changelog](https://keepachangelog.com/).

The short highlights shown in the CLI at startup live in `src/changelog.ts` (bundled into the
build); this file is the fuller human record.

## [0.2.12] - 2026-09-01

### Added
- `/buy-credits` slash command (#241): opens the buy page with no model turn, so it works when
  you are out of usage and every request is rejected.

### Changed
- `free_pi_usage` reports free usage as a percentage of today's allowance (#242). No free-usage
  dollar figure is shown anywhere (cap, spend, lifetime). Purchased credit stays in dollars.

## [0.2.11] - 2026-09-01

### Added
- **Buy more usage when the free daily cap is hit** (epic #221). A purchased credit balance
  covers usage above the free allowance and persists across days. Packs: $5 → $4.00 of usage,
  $10 → $8.00, paid by card or USDC through Stripe Checkout.
- `free_pi_buy_credits` tool (#226): ask pi to buy credits and it opens the buy page in your
  browser and prints the URL (for SSH sessions).
- `free_pi_usage` now shows the purchased balance (#227).

### Changed
- The out-of-usage line in the meter is now server-supplied (#225), so the offer and link can
  change without a CLI update. Against an older server the previous text is shown unchanged.

## [0.2.10] - 2026-08-29

### Changed
- **free-pi now pins the exact agent version it was tested against.** The dependency on
  `@earendil-works/pi-coding-agent` was a `^0.84.2` range, and because the build marks it
  external it resolved on *your* machine at install time — so a fresh install was already
  pulling 0.84.4, a version free-pi had never run a test against. Nobody chose that; npm did.
  It is now pinned to `0.84.4` (tested: 178 CLI tests, typecheck, build, and a real session with
  the ad banner, model-lock and all five extensions loaded). Adopting a newer agent is now a
  deliberate release rather than something that happens to you.
- A nightly CI canary runs the CLI against the *newest* agent release, so a breaking upstream
  change shows up as a red job instead of a user's broken install.

## [0.2.9] - 2026-08-28

Windows fixes and the first cross-platform CI, all from community pull requests by
[@andreolf](https://github.com/andreolf) on the public repo.

### Fixed
- **Windows: self-update never ran.** `npm` on Windows is `npm.cmd`, a batch file, and Node
  refuses to spawn one without a shell. The resulting error was read as "not updatable", so every
  Windows launch silently skipped the update since the feature shipped. The same bug made
  `/update` fail too.
- **Windows: sign-in never opened a browser.** `start` treats its first quoted argument as a
  window title, so the sign-in URL opened an empty console window instead of a browser.
- **Non-interactive runs no longer hang or silently do nothing.** With stdin piped from something
  that never sends a line (CI, `cat | free-pi-cli`), first-run consent waited forever. With stdin
  closed (`< /dev/null`) it printed the consent screen and exited 0 without consenting or
  launching — a success that did nothing. Both now print one line explaining that consent needs a
  terminal, and exit 1.

### Added
- `free-pi-cli logout` — removes the stored sign-in token; the next run signs in again. Purely
  local, so it works offline. Note there is no server-side revoke: the token stays valid until it
  expires.
- `free-pi-cli --version` and `--help`.
- An unrecognized argument now prints help and exits 2, instead of quietly starting a full agent
  session on a typo.

### Security
- The sign-in URL is validated before it is handed to a shell. It arrives from the server and was
  previously passed through with only `&` escaped, which on Windows left `|`, `(` and `)` able to
  run a command. It must now parse as an http/https URL, and every shell metacharacter is escaped.

## [0.2.8] - 2026-08-22

### Added
- Model picker. When the server offers more than one model, `/model` lists them and lets you
  switch; the picker is scoped to exactly the free-pi models. Backed by a server-side model
  catalog, so models can be added or changed without a CLI release. Older CLIs are unaffected —
  they keep using the single active model.

## [0.2.7] - 2026-08-21

### Changed
- The model-lock is now reliable and no longer touches your environment. 0.2.6 hid extra
  providers by deleting their API-key env vars before startup, which (a) missed HuggingFace
  (its token is `HF_TOKEN`, not `*_API_KEY`) and (b) could not hide providers discovered from
  dual-use credentials (AWS Bedrock, Google Vertex) without also deleting those credentials —
  which the agent's shell tool legitimately needs. The lock now leaves every credential in your
  shell intact and instead scopes the model picker to just the free-pi model. Set
  `FREEPI_KEEP_ENV_PROVIDERS=1` to unlock the picker and use your own providers.

## [0.2.6] - 2026-08-21

### Added
- `/close-other-session` — clear a stuck or orphaned session yourself, instead of waiting out the
  timeout, when you hit "you've already got a free-pi session running somewhere". Force-releases
  only your own account's session lease; the one-session-per-account limit is unchanged.
- `/whats-new` — show recent release highlights on demand.
- `/update` — update free-pi-cli to the latest version (a no-op on `npx`, which is always latest).
- "What's new" note shown once at startup after you update to a newer version.

### Changed
- The model list is now limited to the free-pi model instead of inheriting every provider whose
  API key happens to be in your shell (which silently bypassed free-pi). Bring your own key
  deliberately with `/login`, or set `FREEPI_KEEP_ENV_PROVIDERS=1` to keep your shell's provider
  keys.

## [0.2.5] - 2026-08-21

### Added
- The CLI now shows the model the server is actually serving (accurate status-line label) plus a
  one-line notice for trial models.
- Free **Ox Alpha** trial — a frontier preview model, free for the trial period.

## [0.2.4] - 2026-08-20

### Fixed
- Moved the Node-version guard into the bin shim so even very old Node versions get a friendly
  message instead of crashing mid-startup (undici/zstd).

## [0.2.3] - 2026-08-20

### Added
- Preflight check for Node zstd support: a clear "upgrade your Node" message instead of a crash
  mid-request.
