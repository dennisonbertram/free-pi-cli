import { describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { createRealSpawn } from "../src/real-spawn";

type SpawnSyncOptions = { timeout: number; encoding: string; shell: boolean };

/** Records every spawnSync call; never launches a real process. */
function spawnSyncRecorder(result: Partial<ReturnType<typeof spawnSync>> = {}) {
  const calls: Array<{ cmd: string; args: string[]; options: SpawnSyncOptions }> = [];
  const impl = ((cmd: string, args: string[], options: SpawnSyncOptions) => {
    calls.push({ cmd, args, options });
    return { status: 0, stdout: "", stderr: "", pid: 1, output: [], signal: null, ...result };
  }) as unknown as typeof spawnSync;
  return { impl, calls };
}

describe("createRealSpawn — the one non-injected spawn in the distro", () => {
  test("win32 -> shell enabled (npm is npm.cmd; spawning a .cmd without a shell throws EINVAL, which gate (c) read as 'not updatable' — self-update never ran on Windows)", () => {
    const { impl, calls } = spawnSyncRecorder();
    createRealSpawn({ platform: "win32", spawnSyncImpl: impl })("npm", ["root", "-g"], { timeout: 10_000 });
    expect(calls).toEqual([
      { cmd: "npm", args: ["root", "-g"], options: { timeout: 10_000, encoding: "utf8", shell: true } },
    ]);
  });

  test.each(["darwin", "linux"] as const)("%s -> no shell (plain executable resolution, unchanged behavior)", (platform) => {
    const { impl, calls } = spawnSyncRecorder();
    createRealSpawn({ platform, spawnSyncImpl: impl })("npm", ["root", "-g"], { timeout: 10_000 });
    expect(calls[0]?.options.shell).toBe(false);
  });

  test("maps spawnSync's result onto SpawnResult; null stdout becomes ''", () => {
    const { impl } = spawnSyncRecorder({ status: 1, stdout: null as unknown as string });
    const result = createRealSpawn({ platform: "linux", spawnSyncImpl: impl })("npm", [], { timeout: 1 });
    expect(result).toEqual({ status: 1, stdout: "", error: undefined });
  });

  test("propagates spawnSync's error field so self-update's gates can fall back", () => {
    const err = new Error("spawnSync npm EINVAL");
    const { impl } = spawnSyncRecorder({ error: err });
    const result = createRealSpawn({ platform: "win32", spawnSyncImpl: impl })("npm", [], { timeout: 1 });
    expect(result.error).toBe(err);
  });
});
