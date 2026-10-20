import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { relaunchViaNpx, type RelaunchDeps } from "../src/relaunch";

type SpawnOpts = Parameters<RelaunchDeps["spawn"]>[2];

interface Harness {
  deps: RelaunchDeps;
  logs: string[];
  calls: Array<{ cmd: string; args: string[]; opts: SpawnOpts }>;
  child: EventEmitter & { killed: Array<string | undefined>; kill: (s?: NodeJS.Signals) => void };
  signals: Map<string, () => void>;
}

/**
 * `behavior` runs when the fake child is spawned. By default the child "starts
 * the CLI" (touches the ready file the parent hands it) and exits with `code`.
 */
function harness(
  over: Partial<RelaunchDeps> = {},
  behavior: (h: Harness, opts: SpawnOpts) => void = (h, opts) => {
    const ready = opts.env.FREEPI_RELAUNCH_READY;
    if (ready) writeFileSync(ready, "");
    queueMicrotask(() => h.child.emit("exit", 0, null));
  },
): Harness {
  const logs: string[] = [];
  const calls: Harness["calls"] = [];
  const signals = new Map<string, () => void>();
  const child = Object.assign(new EventEmitter(), {
    killed: [] as Array<string | undefined>,
    kill(s?: NodeJS.Signals) {
      this.killed.push(s);
    },
  });
  const h: Harness = { logs, calls, child, signals } as Harness;
  h.deps = {
    env: { PATH: "/bin", HOME: "/h" },
    argv: ["--session", "abc"],
    platform: "darwin",
    autoUpdateEnabled: () => true,
    spawn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      queueMicrotask(() => behavior(h, opts));
      return child as unknown as ReturnType<RelaunchDeps["spawn"]>;
    },
    proc: {
      on: (sig, cb) => void signals.set(sig, cb),
      off: (sig) => void signals.delete(sig),
    },
    log: (m) => logs.push(m),
    ...over,
  };
  return h;
}

describe("relaunchViaNpx", () => {
  test("re-executes via npx --yes free-pi-cli@<latest> with the original argv, inherited stdio and the loop-guard env", async () => {
    const h = harness();
    const code = await relaunchViaNpx("0.4.6", h.deps);
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.cmd).toBe("npx");
    expect(h.calls[0]!.args).toEqual(["--yes", "free-pi-cli@0.4.6", "--session", "abc"]);
    expect(h.calls[0]!.opts.stdio).toBe("inherit");
    expect(h.calls[0]!.opts.shell).toBe(false);
    expect(h.calls[0]!.opts.env.FREEPI_AUTO_UPDATED).toBe("0.4.6");
    expect(h.calls[0]!.opts.env.HOME).toBe("/h"); // env otherwise preserved
    expect(h.logs).toEqual(["Updating free-pi to 0.4.6…"]);
  });

  test("falls back to the 'latest' tag when the server reported no latest version", async () => {
    const h = harness();
    await relaunchViaNpx(undefined, h.deps);
    expect(h.calls[0]!.args.slice(0, 2)).toEqual(["--yes", "free-pi-cli@latest"]);
    expect(h.calls[0]!.opts.env.FREEPI_AUTO_UPDATED).toBe("latest");
  });

  test("a non-semver latest from the server is never put on a command line", async () => {
    const h = harness();
    await relaunchViaNpx("1.0.0; rm -rf ~", h.deps);
    expect(h.calls[0]!.args[1]).toBe("free-pi-cli@latest");
  });

  test("passes the child's exit code through", async () => {
    const h = harness({}, (hh, opts) => {
      writeFileSync(opts.env.FREEPI_RELAUNCH_READY!, "");
      hh.child.emit("exit", 7, null);
    });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(7);
  });

  test("a child killed by a signal exits 128+signal", async () => {
    const h = harness({}, (hh, opts) => {
      writeFileSync(opts.env.FREEPI_RELAUNCH_READY!, "");
      hh.child.emit("exit", null, "SIGTERM");
    });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(143);
  });

  test("POSIX: SIGINT is NOT forwarded (the terminal already signals the whole foreground group); SIGTERM and SIGHUP are; all handlers removed after exit", async () => {
    const h = harness({}, (hh, opts) => {
      writeFileSync(opts.env.FREEPI_RELAUNCH_READY!, "");
      expect(h.signals.has("SIGINT")).toBe(true); // no-op so the parent survives until the child exits
      h.signals.get("SIGINT")?.();
      h.signals.get("SIGTERM")?.();
      h.signals.get("SIGHUP")?.();
      hh.child.emit("exit", 130, null);
    });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(130);
    expect(h.child.killed).toEqual(["SIGTERM", "SIGHUP"]);
    expect(h.signals.size).toBe(0);
  });

  test("win32: no signal handlers are installed at all (console delivers Ctrl+C to the whole group)", async () => {
    const h = harness({ platform: "win32" }, (hh, opts) => {
      writeFileSync(opts.env.FREEPI_RELAUNCH_READY!, "");
      expect(h.signals.size).toBe(0);
      hh.child.emit("exit", 0, null);
    });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(0);
    expect(h.child.killed).toEqual([]);
  });

  test("Ctrl+C (SIGINT) before the CLI wrote the ready file -> 130, not a fallback", async () => {
    const h = harness({}, (hh) => hh.child.emit("exit", null, "SIGINT"));
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(130);
  });

  test("exit code 130 before the ready file -> 130, not a fallback", async () => {
    const h = harness({}, (hh) => hh.child.emit("exit", 130, null));
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(130);
  });

  test("SIGTERM before the ready file -> 143, not a fallback", async () => {
    const h = harness({}, (hh) => hh.child.emit("exit", null, "SIGTERM"));
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(143);
  });

  test("exit code 143 before the ready file -> 143, not a fallback", async () => {
    const h = harness({}, (hh) => hh.child.emit("exit", 143, null));
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(143);
  });

  test("loop guard: already relaunched (FREEPI_AUTO_UPDATED set) -> no spawn, caller falls back", async () => {
    const h = harness({ env: { PATH: "/bin", FREEPI_AUTO_UPDATED: "0.4.6" } });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBeUndefined();
    expect(h.calls).toHaveLength(0);
    expect(h.logs).toEqual([]);
  });

  test("FREEPI_NO_AUTO_UPDATE=1 -> no spawn", async () => {
    const h = harness({ env: { PATH: "/bin", FREEPI_NO_AUTO_UPDATE: "1" } });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBeUndefined();
    expect(h.calls).toHaveLength(0);
    expect(h.logs).toEqual([]);
  });

  test("auto-update turned off in the config file -> no spawn", async () => {
    const h = harness({ autoUpdateEnabled: () => false });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBeUndefined();
    expect(h.calls).toHaveLength(0);
  });

  test("spawn error (e.g. ENOENT, npx missing) -> undefined so the caller prints today's message", async () => {
    const h = harness({}, (hh) => hh.child.emit("error", Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" })));
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBeUndefined();
    expect(h.signals.size).toBe(0);
  });

  test("spawn throwing synchronously -> undefined", async () => {
    const h = harness({
      spawn: () => {
        throw new Error("boom");
      },
    });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBeUndefined();
  });

  test("npx exits non-zero before the CLI ever started (offline) -> undefined, caller prints today's message", async () => {
    const h = harness({}, (hh) => hh.child.emit("exit", 1, null)); // never touches the ready file
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBeUndefined();
  });

  test("non-zero exit AFTER the CLI started is the CLI's own exit code, not a fallback", async () => {
    const h = harness({}, (hh, opts) => {
      writeFileSync(opts.env.FREEPI_RELAUNCH_READY!, "");
      hh.child.emit("exit", 1, null);
    });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(1);
  });

  test("win32 spawns npx.cmd through a shell (a .cmd cannot be spawned directly)", async () => {
    const h = harness({ platform: "win32" });
    await relaunchViaNpx("0.4.6", h.deps);
    expect(h.calls[0]!.cmd).toBe("npx.cmd");
    expect(h.calls[0]!.opts.shell).toBe(true);
    expect(h.calls[0]!.args).toEqual(["--yes", "free-pi-cli@0.4.6", "--session", "abc"]);
  });

  test.each([
    ["delayed-expansion !X!", "!X!"],
    ["open paren", "("],
    ["close paren", ")"],
    ["a space (would split into two args)", "two words"],
    ["an empty arg (would vanish)", ""],
    ["a newline", "a\nb"],
    ["a carriage return", "a\rb"],
    ["an ampersand", "a&calc"],
    ["a percent", "%PATH%"],
    ["a quote", 'a"b'],
  ])("win32 with %s in argv -> refuses to relaunch", async (_name, bad) => {
    const h = harness({ platform: "win32", argv: ["--session", bad] });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBeUndefined();
    expect(h.calls).toHaveLength(0);
    expect(h.logs).toEqual([]);
  });

  test("win32 with ordinary args (--session abc-1) still relaunches", async () => {
    const h = harness({ platform: "win32", argv: ["--session", "abc-1"] });
    expect(await relaunchViaNpx("0.4.6", h.deps)).toBe(0);
    expect(h.calls[0]!.args).toEqual(["--yes", "free-pi-cli@0.4.6", "--session", "abc-1"]);
  });
});

describe("relaunchViaNpx with a real child process (posix)", () => {
  test.skipIf(process.platform === "win32")("real spawn of a fake npx: argv, guard env and exit code arrive; started-handshake file is honored", async () => {
    const { spawn } = await import("node:child_process");
    const { chmodSync, mkdtempSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fake-npx-"));
    const record = join(dir, "record.json");
    const script = join(dir, "npx");
    writeFileSync(
      script,
      `#!/usr/bin/env node
require("fs").writeFileSync(process.env.REC, JSON.stringify({ argv: process.argv.slice(2), guard: process.env.FREEPI_AUTO_UPDATED }));
require("fs").writeFileSync(process.env.FREEPI_RELAUNCH_READY, "");
process.exit(5);
`,
    );
    chmodSync(script, 0o755);
    const logs: string[] = [];
    const code = await relaunchViaNpx("9.9.9", {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, REC: record } as Record<string, string>,
      argv: ["--session", "s1"],
      platform: process.platform,
      autoUpdateEnabled: () => true,
      spawn: (cmd, args, opts) => spawn(cmd, args, opts),
      proc: process,
      log: (m) => logs.push(m),
    });
    expect(code).toBe(5);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual({ argv: ["--yes", "free-pi-cli@9.9.9", "--session", "s1"], guard: "9.9.9" });
    expect(logs).toEqual(["Updating free-pi to 9.9.9…"]);
  });

  test.skipIf(process.platform === "win32")("real child killed by SIGINT before it starts -> 130 and a SIGINT sent to the parent group does not kill the parent", async () => {
    const { spawn } = await import("node:child_process");
    const { chmodSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "fake-npx-"));
    const script = join(dir, "npx");
    writeFileSync(script, `#!/usr/bin/env node\nsetTimeout(() => process.kill(process.pid, "SIGINT"), 150);\nsetTimeout(() => {}, 5000);\n`);
    chmodSync(script, 0o755);
    const logs: string[] = [];
    const before = process.listenerCount("SIGINT");
    const pending = relaunchViaNpx("9.9.9", {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } as Record<string, string>,
      argv: [],
      platform: process.platform,
      autoUpdateEnabled: () => true,
      spawn: (cmd, args, opts) => spawn(cmd, args, opts),
      proc: process,
      log: (m) => logs.push(m),
    });
    // Ctrl+C reaches the parent too; with the no-op handler it must survive.
    process.emit("SIGINT");
    expect(await pending).toBe(130);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  test.skipIf(process.platform === "win32")("npx missing from PATH (ENOENT) -> undefined, not a crash", async () => {
    const { spawn } = await import("node:child_process");
    const code = await relaunchViaNpx("9.9.9", {
      env: { PATH: "/nonexistent" },
      argv: [],
      platform: process.platform,
      autoUpdateEnabled: () => true,
      spawn: (cmd, args, opts) => spawn(cmd, args, opts),
      proc: process,
      log: () => {},
    });
    expect(code).toBeUndefined();
  });
});
