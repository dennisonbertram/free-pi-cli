import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brandMcpLine, piMcpCliPath, runFreePiMcp } from "../src/mcp-command";

const STUB = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-mcp-server.mjs");

function harness() {
  const agentDir = mkdtempSync(join(tmpdir(), "free-pi-mcp-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "free-pi-mcp-cwd-"));
  const out: string[] = [];
  const err: string[] = [];
  const run = (args: string[]) =>
    runFreePiMcp(args, { cwd, agentDir, log: (l) => out.push(l), error: (l) => err.push(l) });
  return { agentDir, out, err, run };
}

describe("pi's mcp command module (guards against a pi upgrade moving it)", () => {
  test("cli.js exists beside the package entry", () => {
    expect(existsSync(piMcpCliPath())).toBe(true);
  });
});

describe("brandMcpLine", () => {
  test("rewrites pi mcp, the global path, and 'Start pi'; keeps project .pi/ paths", () => {
    expect(brandMcpLine("  pi mcp add <server>")).toBe("  free-pi-cli mcp add <server>");
    expect(brandMcpLine('\u001b[2mUse "pi mcp --help" for usage.\u001b[22m')).toBe(
      '\u001b[2mUse "free-pi-cli mcp --help" for usage.\u001b[22m',
    );
    expect(brandMcpLine("Reads ~/.pi/agent/mcp.json and, in trusted projects, .pi/mcp.json.")).toBe(
      "Reads ~/.free-pi/agent/mcp.json and, in trusted projects, .pi/mcp.json.",
    );
    expect(brandMcpLine("Start pi in the project to trust it.")).toBe("Start free-pi-cli in the project to trust it.");
    expect(brandMcpLine("pip install epic")).toBe("pip install epic");
  });
});

describe("runFreePiMcp against a temp agent dir", () => {
  test("--help is branded", async () => {
    const h = harness();
    expect(await h.run(["--help"])).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("free-pi-cli mcp add");
    expect(text).not.toMatch(/\bpi mcp\b/);
    expect(text).toContain("~/.free-pi/agent/mcp.json");
  });

  test("add, list, list --json, remove write and read the agent dir's mcp.json", async () => {
    const h = harness();
    expect(await h.run(["add", "stub", "--", process.execPath, STUB])).toBe(0);
    const file = join(h.agentDir, "mcp.json");
    const config = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(config.mcpServers.stub).toEqual({ command: process.execPath, args: [STUB] });
    expect(h.out.join("\n")).toContain("free-pi-cli mcp list");
    expect(h.out.join("\n")).not.toMatch(/\bpi mcp\b/);

    h.out.length = 0;
    expect(await h.run(["list"])).toBe(0);
    expect(h.out.join("\n")).toContain("stub: connected, 1 tool");
    expect(h.out.join("\n")).toContain("tools: echo");

    h.out.length = 0;
    expect(await h.run(["list", "--json"])).toBe(0);
    const json = JSON.parse(h.out.join("\n")) as { servers: Array<{ name: string }> };
    expect(json.servers.map((s) => s.name)).toEqual(["stub"]);

    expect(await h.run(["remove", "stub"])).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf8")).mcpServers).toEqual({});
  });

  test("an unknown subcommand fails with branded usage", async () => {
    const h = harness();
    expect(await h.run(["bogus"])).not.toBe(0);
    expect(h.err.join("\n")).toContain('Use "free-pi-cli mcp --help"');
  });

  test("a missing pi module is a clear error with exit 1", async () => {
    const h = harness();
    const err: string[] = [];
    const code = await runFreePiMcp(["list"], {
      cwd: h.agentDir,
      agentDir: h.agentDir,
      log: () => {},
      error: (l) => err.push(l),
      loadRunner: async () => {
        throw new Error("free-pi-cli mcp is unavailable: nope");
      },
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("unavailable");
  });
});
