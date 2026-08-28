import * as zlib from "node:zlib";

/**
 * Preflight guard against a known upstream crash. The pi agent's bundled undici
 * unconditionally advertises `Accept-Encoding: zstd` and calls
 * `zlib.createZstdDecompress()` when a response comes back zstd-encoded — with no
 * Node-version guard of its own. That function only exists in Node >= 22.15 (LTS)
 * and >= 23.8 (Current); on older Node the agent dies with an uncaught
 * `TypeError: zlib.createZstdDecompress is not a function`, killing the process
 * mid-session (see earendil-works/pi#7771).
 *
 * We check the capability DIRECTLY rather than parse the Node version, because a
 * version check is fragile across the two release lines (`>=22.19.0` semver is
 * satisfied by Node 23.0-23.7, which still crash). If `createZstdDecompress`
 * exists, this runtime is safe; if not, the user WILL crash, so we fail fast with
 * an actionable message instead.
 *
 * Pure + injectable so it can be unit-tested without a second Node runtime.
 * Returns the error message to print, or `null` when zstd is supported.
 */
export function zstdSupportError(
  zlibModule: { createZstdDecompress?: unknown } = zlib,
  nodeVersion: string = process.versions.node,
): string | null {
  if (typeof zlibModule.createZstdDecompress === "function") return null;
  return [
    `free-pi-cli can't run on Node ${nodeVersion}.`,
    ``,
    `The pi agent needs Node with zstd support (Node >= 22.15, or >= 23.8 on the`,
    `Current line) — older Node crashes mid-request inside the agent. Upgrade Node:`,
    ``,
    `  nvm install 22     # then re-run:  npx free-pi-cli`,
    ``,
    `(or update your system Node to the latest LTS.)`,
  ].join("\n");
}
