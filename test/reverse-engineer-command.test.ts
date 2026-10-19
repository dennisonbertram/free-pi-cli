import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { createFreePiCommandsExtension, type CreateCommandsOptions } from "../src/commands";
import { buildRuntimeOptions } from "../src/pi-launch";

const stubServer = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-mcp-server.mjs");
const COMMAND = "reverse-engineer-anything";

type Handler = (args: string, ctx: unknown) => unknown;

/** Runs the commands extension against a fake pi and records what it registers. */
function fakePi(extra: Partial<CreateCommandsOptions> = {}) {
  const commands = new Map<string, { description?: string; handler: Handler }>();
  const servers: Array<{ name: string; config: Record<string, unknown> }> = [];
  const notes: Array<{ msg: string; type?: string }> = [];
  const pi = {
    on: () => undefined,
    registerCommand: (name: string, def: { description?: string; handler: Handler }) => commands.set(name, def),
    registerMcpServer: (name: string, config: Record<string, unknown>) => {
      const i = servers.findIndex((s) => s.name === name);
      if (i >= 0) servers.splice(i, 1);
      servers.push({ name, config });
    },
    getMcpServers: () => servers,
  };
  const ext = createFreePiCommandsExtension({ baseUrl: "https://api.test", getToken: () => "t", ...extra });
  (ext as unknown as { factory: (pi: unknown) => void }).factory(pi);
  const ctx = { ui: { notify: (msg: string, type?: string) => notes.push({ msg, type }) } };
  const run = () => commands.get(COMMAND)!.handler("", ctx);
  return { commands, servers, notes, run };
}

describe("/reverse-engineer-anything registration", () => {
  test("is registered as a slash command with a description", () => {
    const { commands } = fakePi();
    expect(commands.has(COMMAND)).toBe(true);
    expect(commands.get(COMMAND)!.description).toContain("reverse-engineering");
  });

  test("registers no MCP server until the command runs", () => {
    const { servers } = fakePi();
    expect(servers).toEqual([]);
  });
});

describe("/reverse-engineer-anything handler", () => {
  test("registers rea with the pinned npx command, codemode exposure and a description", async () => {
    const { servers, notes, run } = fakePi({ nodeVersion: "24.15.0", platform: "darwin" });
    await run();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.name).toBe("rea");
    expect(servers[0]!.config).toMatchObject({
      command: "npx",
      args: ["-y", "rea-agents@6.7.0", "mcp"],
      exposure: "codemode",
    });
    expect(String(servers[0]!.config.description)).toContain("Reverse-engineering");
    const text = notes.map((n) => n.msg).join("\n");
    expect(text).toContain("rea-agents"); // first run downloads it
    expect(text).toMatch(/Hopper/);
    expect(text).toMatch(/Ghidra/);
    expect(text).toMatch(/IDA/);
  });

  test("on win32 wraps npx in cmd.exe", async () => {
    const { servers, run } = fakePi({ nodeVersion: "24.15.0", platform: "win32" });
    await run();
    expect(servers[0]!.config).toMatchObject({
      command: "cmd.exe",
      args: ["/d", "/c", "npx", "-y", "rea-agents@6.7.0", "mcp"],
    });
  });

  test("running twice leaves one registration and says it is already loaded", async () => {
    const { servers, notes, run } = fakePi({ nodeVersion: "24.15.0" });
    await run();
    notes.length = 0;
    await run();
    expect(servers).toHaveLength(1);
    expect(notes[0]!.msg).toContain("already loaded");
  });

  test.each(["20.11.0", "22.18.9", "23.5.0", "24.10.0", "25.1.0"])(
    "Node %s is outside rea's range: no registration, user is told which versions work",
    async (nodeVersion) => {
      const { servers, notes, run } = fakePi({ nodeVersion });
      await run();
      expect(servers).toEqual([]);
      expect(notes).toHaveLength(1);
      expect(notes[0]!.type).toBe("error");
      expect(notes[0]!.msg).toContain(nodeVersion);
      expect(notes[0]!.msg).toContain("22.19");
    },
  );

  test.each(["22.19.0", "22.22.1", "24.11.0", "24.15.0", "26.0.0", "27.1.0"])("Node %s is accepted", async (nodeVersion) => {
    const { servers, run } = fakePi({ nodeVersion });
    await run();
    expect(servers).toHaveLength(1);
  });
});

// ---- real pi session -------------------------------------------------------

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("/reverse-engineer-anything in a real pi session", () => {
  test("rea is absent until the command runs, then connects and exposes its tools through codemode", async () => {
    const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "free-pi-rea-agent-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "free-pi-rea-cwd-")));
    const baseUrl = "http://127.0.0.1:9"; // never contacted: the command is not a model turn
    const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions({ baseUrl, jwt: "t", agentDir }, "rea");
    // Same extension list as production; only the rea launch command points at the stub server.
    resourceLoaderOptions.extensionFactories = resourceLoaderOptions.extensionFactories.map((e) =>
      (e as { name: string }).name === "free-pi-commands"
        ? createFreePiCommandsExtension({
            baseUrl,
            getToken: () => "t",
            nodeVersion: "24.15.0",
            reaServer: { command: process.execPath, args: [stubServer] },
          })
        : e,
    );
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [...tools],
    });
    cleanups.push(() => session.dispose());

    const notes: string[] = [];
    const noop = () => undefined;
    const ui = new Proxy({ notify: (m: string) => notes.push(m) } as Record<string, unknown>, {
      get: (t, k) => (k in t ? t[k as string] : noop),
    });
    await session.bindExtensions({ uiContext: ui as never, mode: "tui" });

    const reaTools = () => session.getAllTools().filter((t) => t.name.startsWith("mcp__rea__"));
    expect(reaTools()).toEqual([]);

    await session.prompt(`/${COMMAND}`);
    const end = Date.now() + 10_000;
    while (reaTools().length === 0 && Date.now() < end) await Bun.sleep(25);

    expect(reaTools().map((t) => t.name)).toEqual(["mcp__rea__echo"]);
    // codemode exposure: reachable from codemode scripts, but not declared to the model directly.
    expect(session.getActiveToolNames()).not.toContain("mcp__rea__echo");
    expect(session.getActiveToolNames()).toContain("codemode");
    expect(notes.join("\n")).toContain("rea-agents");
  }, 20_000);
});

describe("regression: users who never run /reverse-engineer-anything", () => {
  test("the production extension list offers the command but rea stays out of the tools and the system prompt", async () => {
    const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "free-pi-rea-agent-")));
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "free-pi-rea-cwd-")));
    const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(
      { baseUrl: "http://127.0.0.1:9", jwt: "t", agentDir },
      "rea-regression",
    );
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [...tools],
    });
    cleanups.push(() => session.dispose());
    await session.bindExtensions({});

    expect(session.extensionRunner.getRegisteredCommands().map((c) => c.name)).toContain(COMMAND);
    expect(session.getAllTools().filter((t) => t.name.startsWith("mcp__rea__"))).toEqual([]);
    expect(session.systemPrompt).not.toMatch(/rea-agents|Reverse-engineering tools|mcp__rea__/);
  }, 20_000);
});
