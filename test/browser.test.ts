import { describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { buildOpenCommand, openBrowser } from "../src/browser";

/** Records every spawn call and returns an inert child, so no real process is ever launched. */
function spawnRecorder(script?: () => ReturnType<typeof spawn>) {
  const calls: Array<{ command: string; args: string[]; options: Record<string, unknown> }> = [];
  let unrefCount = 0;
  const child = {
    on: () => child,
    unref: () => {
      unrefCount++;
    },
  } as unknown as ReturnType<typeof spawn>;
  const spawnImpl = ((command: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return script ? script() : child;
  }) as unknown as typeof spawn;
  return { spawnImpl, calls, unrefCount: () => unrefCount };
}

const URL_PLAIN = "https://github.com/login/device";
const URL_WITH_AMP = "https://example.com/verify?code=abc&session=xyz";

describe("buildOpenCommand — per-platform open command", () => {
  test("darwin -> open <url>, no verbatim args", () => {
    expect(buildOpenCommand(URL_PLAIN, "darwin")).toEqual({ command: "open", args: [URL_PLAIN] });
  });

  test("linux -> xdg-open <url>", () => {
    expect(buildOpenCommand(URL_PLAIN, "linux")).toEqual({ command: "xdg-open", args: [URL_PLAIN] });
  });

  test('win32 -> cmd /c start "" <url>, verbatim args (start is a cmd builtin; "" is the explicit window title)', () => {
    expect(buildOpenCommand(URL_PLAIN, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", '""', URL_PLAIN],
      windowsVerbatimArguments: true,
    });
  });

  test("win32 -> `&` in a query string is ^-escaped so cmd cannot split the URL", () => {
    const { args } = buildOpenCommand(URL_WITH_AMP, "win32");
    expect(args[3]).toBe("https://example.com/verify?code=abc^&session=xyz");
  });

  test("non-win32 -> URL passed through byte-for-byte (no shell, nothing to escape)", () => {
    expect(buildOpenCommand(URL_WITH_AMP, "linux").args).toEqual([URL_WITH_AMP]);
  });
});

describe("openBrowser — best-effort, never throws", () => {
  test("spawns the built command detached with ignored stdio, then unrefs", () => {
    const { spawnImpl, calls, unrefCount } = spawnRecorder();
    openBrowser(URL_PLAIN, "darwin", spawnImpl);
    expect(calls).toEqual([
      {
        command: "open",
        args: [URL_PLAIN],
        options: { stdio: "ignore", detached: true, windowsVerbatimArguments: undefined },
      },
    ]);
    expect(unrefCount()).toBe(1);
  });

  test("win32 spawn carries windowsVerbatimArguments so Node's own quoting cannot re-title the start window", () => {
    const { spawnImpl, calls } = spawnRecorder();
    openBrowser(URL_PLAIN, "win32", spawnImpl);
    expect(calls[0]?.command).toBe("cmd");
    expect(calls[0]?.options.windowsVerbatimArguments).toBe(true);
  });

  test("spawn throwing synchronously is swallowed (printed URL/code is the primary path)", () => {
    const { spawnImpl } = spawnRecorder(() => {
      throw new Error("EPERM");
    });
    expect(() => openBrowser(URL_PLAIN, "linux", spawnImpl)).not.toThrow();
  });
});
