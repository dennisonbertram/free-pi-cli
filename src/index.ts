// Bin entry SHIM. This runs the Node-capability guard BEFORE any static import
// that would load undici.
//
// Why a shim and not a check inside main(): `run.ts` / `pi-launch.ts` do *value*
// imports from `@earendil-works/pi-coding-agent`, which loads undici@8.9.0 at
// module-load time. ES-module imports are hoisted, so on an old Node undici's own
// load crashes (e.g. `webidl.util.markAsUncloneable` on Node 20) — or, one notch
// newer, it loads fine but later crashes on `zlib.createZstdDecompress` — BEFORE
// any guard placed in main() could run. This bit us in 0.2.3, which put the guard
// in main() and so only caught the zstd window, not the older undici-load crash.
//
// This module imports ONLY `node:zlib` + `./node-check` (neither loads undici), so
// it evaluates cleanly on ANY Node. It checks zstd support, prints a friendly
// message and exits on failure, and only then dynamically imports the real CLI —
// which is when undici finally loads, on a runtime we've confirmed can handle it.
import * as zlib from "node:zlib";
import { HELP_TEXT, parseCliArgs, versionLine } from "./cli-args";
import { zstdSupportError } from "./node-check";

const err = zstdSupportError(zlib, process.versions.node);
if (err) {
  console.error(err);
  process.exit(1);
}

// Local text commands print before the heavy import below. `cli-args` and
// `version` only reach node builtins + package.json, so `--version`/`--help`
// stay at bare-Node speed instead of paying main.ts's static import of
// ./pi-launch -> @earendil-works/pi-coding-agent (~4.5 s on a phone, most of
// it module-graph loading the CLI never uses for a one-line reply). main()
// still handles both kinds, so nothing here changes the output.
const early = parseCliArgs(process.argv.slice(2));
if (early.kind === "version") {
  console.log(versionLine());
  process.exit(0);
}
if (early.kind === "help") {
  console.log(HELP_TEXT);
  process.exit(0);
}

// Guard passed: load the real CLI (this is where undici gets pulled in).
await import("./main");
