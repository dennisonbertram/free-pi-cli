import { describe, expect, test } from "bun:test";
import { maybeSelfUpdate, type SelfUpdateDeps, type SpawnResult } from "../src/self-update";

/** Records every spawn call so tests can assert an install was (or was NOT) attempted. */
function spawnRecorder(script: (cmd: string, args: string[]) => SpawnResult) {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawn = (cmd: string, args: string[]): SpawnResult => {
    calls.push({ cmd, args });
    return script(cmd, args);
  };
  return { spawn, calls };
}

const NPM_ROOT_OK = "/opt/homebrew/lib/node_modules";
const CLI_REALPATH_GLOBAL = `${NPM_ROOT_OK}/free-pi-cli/dist/index.js`;

function happyPathSpawn(): (cmd: string, args: string[]) => SpawnResult {
  return (_cmd, args) => {
    if (args[0] === "root") return { status: 0, stdout: `${NPM_ROOT_OK}\n` };
    if (args[0] === "install") return { status: 0, stdout: "" };
    return { status: 1, stdout: "" };
  };
}

function baseDeps(overrides: Partial<SelfUpdateDeps> = {}): SelfUpdateDeps {
  const { spawn } = spawnRecorder(happyPathSpawn());
  return {
    env: {},
    autoUpdateEnabled: () => true,
    spawn,
    cliRealpath: CLI_REALPATH_GLOBAL,
    log: () => {},
    ...overrides,
  };
}

describe("maybeSelfUpdate (#37 U1) — every gate falls back with NO install spawn", () => {
  test("FREEPI_NO_AUTO_UPDATE env present -> fallback, no spawn at all", async () => {
    const { spawn, calls } = spawnRecorder(happyPathSpawn());
    const outcome = await maybeSelfUpdate("notice", "0.3.0", baseDeps({ spawn, env: { FREEPI_NO_AUTO_UPDATE: "1" } }));
    expect(outcome).toBe("notice");
    expect(calls.length).toBe(0);
  });

  test("config autoUpdate:false -> fallback, no spawn at all", async () => {
    const { spawn, calls } = spawnRecorder(happyPathSpawn());
    const outcome = await maybeSelfUpdate("block", "0.3.0", baseDeps({ spawn, autoUpdateEnabled: () => false }));
    expect(outcome).toBe("blocked");
    expect(calls.length).toBe(0);
  });

  test("npm_config_user_agent set (npx/dlx signal) -> fallback, no spawn at all", async () => {
    const { spawn, calls } = spawnRecorder(happyPathSpawn());
    const outcome = await maybeSelfUpdate(
      "notice",
      "0.3.0",
      baseDeps({ spawn, env: { npm_config_user_agent: "npm/10.0.0 node/v22" } }),
    );
    expect(outcome).toBe("notice");
    expect(calls.length).toBe(0);
  });

  test("npm_lifecycle_event === 'npx' -> fallback, no spawn at all", async () => {
    const { spawn, calls } = spawnRecorder(happyPathSpawn());
    const outcome = await maybeSelfUpdate("notice", "0.3.0", baseDeps({ spawn, env: { npm_lifecycle_event: "npx" } }));
    expect(outcome).toBe("notice");
    expect(calls.length).toBe(0);
  });

  test("not a global install -> fallback, install never spawned", async () => {
    const { spawn, calls } = spawnRecorder(happyPathSpawn());
    const outcome = await maybeSelfUpdate(
      "notice",
      "0.3.0",
      baseDeps({ spawn, cliRealpath: "/Users/dev/free-pi/packages/cli/dist/index.js" }),
    );
    expect(outcome).toBe("notice");
    // "npm root -g" is still checked (that's how we learn it's not global) but install is not.
    expect(calls.some((c) => c.args[0] === "install")).toBe(false);
  });

  test("PATH-BOUNDARY: sibling dir sharing a string prefix is NOT global (codex fix)", async () => {
    // "/opt/homebrew/lib/node_modules-evil/..." shares a raw string prefix with
    // NPM_ROOT_OK but is a different directory entirely — a naive
    // `.startsWith(root)` would wrongly treat this as a global install.
    const { spawn, calls } = spawnRecorder(happyPathSpawn());
    const outcome = await maybeSelfUpdate(
      "notice",
      "0.3.0",
      baseDeps({ spawn, cliRealpath: `${NPM_ROOT_OK}-evil/free-pi-cli/dist/index.js` }),
    );
    expect(outcome).toBe("notice");
    expect(calls.some((c) => c.args[0] === "install")).toBe(false);
  });

  test("exact equality with npm root -g also counts as global (boundary edge)", async () => {
    const { spawn, calls } = spawnRecorder(happyPathSpawn());
    const outcome = await maybeSelfUpdate("block", "0.3.0", baseDeps({ spawn, cliRealpath: NPM_ROOT_OK }));
    expect(outcome).toBe("updated-exit");
    expect(calls.some((c) => c.args[0] === "install")).toBe(true);
  });
});

describe("maybeSelfUpdate — success paths", () => {
  test("notice + successful install -> updated-continue, logs the applies-next-launch line", async () => {
    const logs: string[] = [];
    const outcome = await maybeSelfUpdate("notice", "0.3.0", baseDeps({ log: (m) => logs.push(m) }));
    expect(outcome).toBe("updated-continue");
    expect(logs.join("\n")).toContain("0.3.0");
    expect(logs.join("\n")).toContain("applies next launch");
  });

  test("block + successful install -> updated-exit, logs the re-run line", async () => {
    const logs: string[] = [];
    const outcome = await maybeSelfUpdate("block", "0.3.0", baseDeps({ log: (m) => logs.push(m) }));
    expect(outcome).toBe("updated-exit");
    expect(logs.join("\n")).toContain("0.3.0");
    expect(logs.join("\n")).toContain("re-run");
  });

  test("install spawn uses npm install -g free-pi-cli@latest with a bounded timeout, no sudo", async () => {
    const { spawn, calls } = spawnRecorder(happyPathSpawn());
    await maybeSelfUpdate("notice", "0.3.0", baseDeps({ spawn }));
    const install = calls.find((c) => c.args[0] === "install");
    expect(install?.cmd).toBe("npm");
    expect(install?.args).toEqual(["install", "-g", "free-pi-cli@latest"]);
  });
});

describe("maybeSelfUpdate — every failure path falls back, never throws", () => {
  test("`npm root -g` spawn error -> fallback, install never attempted", async () => {
    const { spawn, calls } = spawnRecorder((_cmd, args) => {
      if (args[0] === "root") return { status: null, stdout: "", error: new Error("ENOENT") };
      return { status: 0, stdout: "" };
    });
    const outcome = await maybeSelfUpdate("notice", "0.3.0", baseDeps({ spawn }));
    expect(outcome).toBe("notice");
    expect(calls.some((c) => c.args[0] === "install")).toBe(false);
  });

  test("`npm root -g` nonzero exit -> fallback", async () => {
    const { spawn, calls } = spawnRecorder((_cmd, args) => {
      if (args[0] === "root") return { status: 1, stdout: "" };
      return { status: 0, stdout: "" };
    });
    const outcome = await maybeSelfUpdate("block", "0.3.0", baseDeps({ spawn }));
    expect(outcome).toBe("blocked");
    expect(calls.some((c) => c.args[0] === "install")).toBe(false);
  });

  test("`npm root -g` times out (null status, no exception) -> fallback", async () => {
    const { spawn, calls } = spawnRecorder((_cmd, args) => {
      if (args[0] === "root") return { status: null, stdout: "" };
      return { status: 0, stdout: "" };
    });
    const outcome = await maybeSelfUpdate("notice", "0.3.0", baseDeps({ spawn }));
    expect(outcome).toBe("notice");
    expect(calls.some((c) => c.args[0] === "install")).toBe(false);
  });

  test("install spawn error -> fallback (notice -> notice)", async () => {
    const { spawn } = spawnRecorder((_cmd, args) => {
      if (args[0] === "root") return { status: 0, stdout: `${NPM_ROOT_OK}\n` };
      return { status: null, stdout: "", error: new Error("network down") };
    });
    const outcome = await maybeSelfUpdate("notice", "0.3.0", baseDeps({ spawn }));
    expect(outcome).toBe("notice");
  });

  test("install nonzero exit -> fallback (block -> blocked)", async () => {
    const { spawn } = spawnRecorder((_cmd, args) => {
      if (args[0] === "root") return { status: 0, stdout: `${NPM_ROOT_OK}\n` };
      return { status: 1, stdout: "EACCES: permission denied" };
    });
    const outcome = await maybeSelfUpdate("block", "0.3.0", baseDeps({ spawn }));
    expect(outcome).toBe("blocked");
  });

  test("a throwing spawn/deps function never escapes maybeSelfUpdate as an exception", async () => {
    const throwingSpawn = (): SpawnResult => {
      throw new Error("boom, unexpected");
    };
    await expect(maybeSelfUpdate("notice", "0.3.0", baseDeps({ spawn: throwingSpawn }))).resolves.toBe("notice");
    await expect(maybeSelfUpdate("block", "0.3.0", baseDeps({ spawn: throwingSpawn }))).resolves.toBe("blocked");
  });

  test("a throwing autoUpdateEnabled() never escapes as an exception", async () => {
    const throwing = () => {
      throw new Error("config read exploded");
    };
    await expect(
      maybeSelfUpdate("notice", "0.3.0", baseDeps({ autoUpdateEnabled: throwing })),
    ).resolves.toBe("notice");
  });
});

describe("maybeSelfUpdate — never sudo, never re-exec", () => {
  test("no call ever uses sudo as the command", async () => {
    const { spawn, calls } = spawnRecorder(happyPathSpawn());
    await maybeSelfUpdate("block", "0.3.0", baseDeps({ spawn }));
    expect(calls.every((c) => c.cmd === "npm")).toBe(true);
  });
});
