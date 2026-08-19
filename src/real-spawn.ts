// The real `spawn` dep for self-update.ts: sync + bounded timeout, never
// sudo. Extracted from index.ts (which runs main() on import, so nothing in
// it is unit-testable) as a test seam for the one branch that matters:
//
// On Windows the npm CLI is `npm.cmd`, a batch file, not an executable.
// spawnSync("npm", ...) without a shell cannot run it — since Node's
// CVE-2024-27980 hardening it throws EINVAL rather than resolving the .cmd.
// That error landed in `result.error`, which self-update.ts's gate (c)
// treats as "not updatable" and silently falls back — so self-update never
// once worked on Windows, on every launch, with no visible symptom.
//
// `shell: true` on win32 is safe here by construction: the only commands
// self-update.ts ever issues are fixed literals ("npm root -g" /
// "npm install -g free-pi-cli@latest") — no user input, no quoting surface.
import { spawnSync } from "node:child_process";
import type { SpawnResult } from "./self-update";

export interface RealSpawnIO {
  platform: NodeJS.Platform;
  spawnSyncImpl: typeof spawnSync;
}

export function createRealSpawn(
  io: RealSpawnIO = { platform: process.platform, spawnSyncImpl: spawnSync },
): (cmd: string, args: string[], opts: { timeout: number }) => SpawnResult {
  return (cmd, args, opts) => {
    const result = io.spawnSyncImpl(cmd, args, {
      timeout: opts.timeout,
      encoding: "utf8",
      shell: io.platform === "win32",
    });
    return { status: result.status, stdout: result.stdout ?? "", error: result.error };
  };
}
