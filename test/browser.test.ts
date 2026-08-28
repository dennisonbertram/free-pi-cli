import { describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { buildOpenCommand, openBrowser, safeBrowserUrl } from "../src/browser";

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

describe("safeBrowserUrl — the URL arrives from the server, so this is the gate", () => {
  test.each([
    ["https://github.com/login/device"],
    ["http://localhost:8787/verify?code=abc&session=xyz"],
  ])("%s -> allowed, returned normalized", (url) => {
    expect(safeBrowserUrl(url)).toBe(new URL(url).href);
  });

  test.each([
    ["file:///etc/passwd"],
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    ["vscode://install?x=1"],
    ["not a url at all"],
    [""],
  ])("%p -> rejected (a non-http scheme handed to open/start is a launch primitive, not a link)", (url) => {
    expect(safeBrowserUrl(url)).toBeNull();
  });
});

describe("win32 command injection — server-supplied URL reaches cmd verbatim", () => {
  // Measured, not assumed: WHATWG normalization encodes >, ^, " and space,
  // but passes | ( ) through untouched — so escaping cannot be skipped.
  test.each([["|"], ["("], [")"]])(
    "%p survives URL normalization, so buildOpenCommand must escape it",
    (char) => {
      const url = `https://evil.example/x${char}y`;
      expect(new URL(url).href).toContain(char);
      expect(buildOpenCommand(new URL(url).href, "win32").args[3]).toContain(`^${char}`);
    },
  );

  test("a piped payload is neutralized: every metacharacter is ^-escaped", () => {
    const { args } = buildOpenCommand("https://evil.example/a|calc.exe&b>out.txt", "win32");
    expect(args[3]).toBe("https://evil.example/a^|calc.exe^&b^>out.txt");
  });

  test("^ itself is escaped (it is cmd's escape character, so an unescaped one would consume the next char)", () => {
    expect(buildOpenCommand("https://e.example/a^b", "win32").args[3]).toBe("https://e.example/a^^b");
  });

  test("openBrowser refuses a non-http URL outright — nothing is spawned", () => {
    const { spawnImpl, calls } = spawnRecorder();
    openBrowser("file:///etc/passwd", "win32", spawnImpl);
    expect(calls).toEqual([]);
  });
});
