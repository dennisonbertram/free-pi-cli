import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ProjectTrustStore,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, settingsForRuntime } from "../src/pi-launch";
import { decideProjectTrust, PROJECT_TRUST_PROMPT, projectTrustForCwd } from "../src/project-trust";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

function setup(opts: { resources: boolean; tty: boolean; answer?: string }) {
  const agentDir = tmp("free-pi-trust-agent-");
  const cwd = tmp("free-pi-trust-cwd-");
  const asked: string[] = [];
  const logs: string[] = [];
  const run = () =>
    decideProjectTrust(cwd, agentDir, {
      hasTrustRequiringResources: () => opts.resources,
      stdinIsTTY: opts.tty,
      log: (m) => logs.push(m),
      askLine: async (p) => {
        asked.push(p);
        return opts.answer ?? "";
      },
    });
  return { agentDir, cwd, asked, logs, run, store: () => new ProjectTrustStore(agentDir) };
}

describe("decideProjectTrust", () => {
  test("no project resources: trusted without asking or saving", async () => {
    const s = setup({ resources: false, tty: true });
    expect(await s.run()).toBe(true);
    expect(s.asked).toEqual([]);
    expect(s.store().get(s.cwd)).toBeNull();
  });

  test.each([true, false])("saved decision %p is used without asking", async (saved) => {
    const s = setup({ resources: true, tty: true });
    s.store().set(s.cwd, saved);
    expect(await s.run()).toBe(saved);
    expect(s.asked).toEqual([]);
  });

  test.each([
    ["y", true],
    ["Yes", true],
    ["n", false],
    ["", false],
    ["maybe", false],
  ])("no saved decision, TTY, answer %p -> %p and is saved", async (answer, expected) => {
    const s = setup({ resources: true, tty: true, answer });
    expect(await s.run()).toBe(expected);
    expect(s.asked).toEqual([PROJECT_TRUST_PROMPT]);
    expect(s.store().get(s.cwd)).toBe(expected);
  });

  test("no saved decision and no TTY: untrusted, no prompt, nothing saved", async () => {
    const s = setup({ resources: true, tty: false });
    expect(await s.run()).toBe(false);
    expect(s.asked).toEqual([]);
    expect(s.store().get(s.cwd)).toBeNull();
  });
});

describe("buildRuntimeOptions projectTrusted", () => {
  const base = () => ({ baseUrl: "http://example.test", jwt: "t", agentDir: tmp("free-pi-trust-agent-") });

  test("false and true are carried into the settings manager; absent means untrusted", () => {
    expect(buildRuntimeOptions({ ...base(), projectTrusted: false }, "s").settingsManager.isProjectTrusted()).toBe(false);
    expect(buildRuntimeOptions({ ...base(), projectTrusted: true }, "s").settingsManager.isProjectTrusted()).toBe(true);
    expect(buildRuntimeOptions(base(), "s").settingsManager.isProjectTrusted()).toBe(false);
  });
});

describe("an untrusted project's code does not load", () => {
  const server = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-mcp-server.mjs");

  async function loadedFor(projectTrusted: boolean): Promise<{ names: string[]; extensionPaths: string[] }> {
    const agentDir = tmp("free-pi-trust-agent-");
    const cwd = tmp("free-pi-trust-cwd-");
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { projsrv: { command: process.execPath, args: [server] } } }),
    );
    writeFileSync(
      join(cwd, ".pi", "extensions", "evil.ts"),
      `export default function (pi) { pi.registerTool({ name: "evil_tool", label: "evil", description: "x", parameters: { type: "object", properties: {} }, async execute() { return { content: [{ type: "text", text: "x" }], details: {} }; } }); }\n`,
    );
    const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(
      { baseUrl: "http://127.0.0.1:9", jwt: "t", agentDir, projectTrusted },
      "s",
    );
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [...tools],
    });
    try {
      await session.bindExtensions({});
      // The MCP server connects in the background after session_start. Trusted: poll until it
      // appears. Untrusted: wait a fixed time, since there is nothing to wait for.
      const connected = () => session.getAllTools().some((t) => t.name.startsWith("mcp__projsrv"));
      const deadline = Date.now() + (projectTrusted ? 10_000 : 1_500);
      while (Date.now() < deadline && !connected()) await Bun.sleep(50);
      return {
        names: session.getAllTools().map((t) => t.name),
        extensionPaths: services.resourceLoader.getExtensions().extensions.map((e: { path: string }) => e.path),
      };
    } finally {
      session.dispose();
    }
  }

  test("untrusted: neither the project MCP server nor .pi/extensions loads", async () => {
    const { names, extensionPaths } = await loadedFor(false);
    expect(extensionPaths.some((p) => p.endsWith("evil.ts"))).toBe(false);
    expect(names.some((n) => n.startsWith("mcp__projsrv"))).toBe(false);
  }, 20_000);

  test("trusted: both load (proves the test can see them)", async () => {
    // evil_tool itself is hidden by the strict `tools` allowlist; the extension still loads.
    const { names, extensionPaths } = await loadedFor(true);
    expect(extensionPaths.some((p) => p.endsWith("evil.ts"))).toBe(true);
    expect(names).toContain("mcp__projsrv__echo");
  }, 20_000);
});

describe("trust is decided per runtime folder (P1: resume/switch into another folder)", () => {
  const agentDir = () => tmp("free-pi-trust-agent-");
  const opts = (dir: string) => ({ baseUrl: "http://example.test", jwt: "t", agentDir: dir });

  test("the launch folder keeps the answer it was asked for", () => {
    const dir = agentDir();
    const launch = tmp("free-pi-trust-a-");
    expect(projectTrustForCwd(launch, { cwd: launch, trusted: true }, dir, () => true)).toBe(true);
    expect(projectTrustForCwd(launch, { cwd: launch, trusted: false }, dir, () => true)).toBe(false);
  });

  test("another folder with protected resources: saved false and no decision are untrusted, saved true is trusted", () => {
    const dir = agentDir();
    const a = tmp("free-pi-trust-a-");
    const b = tmp("free-pi-trust-b-");
    expect(projectTrustForCwd(b, { cwd: a, trusted: true }, dir, () => true)).toBe(false);
    new ProjectTrustStore(dir).set(b, false);
    expect(projectTrustForCwd(b, { cwd: a, trusted: true }, dir, () => true)).toBe(false);
    new ProjectTrustStore(dir).set(b, true);
    expect(projectTrustForCwd(b, { cwd: a, trusted: true }, dir, () => true)).toBe(true);
  });

  test("another folder with nothing to protect is trusted", () => {
    const dir = agentDir();
    expect(projectTrustForCwd(tmp("free-pi-trust-b-"), { cwd: tmp("free-pi-trust-a-"), trusted: false }, dir, () => false)).toBe(true);
  });

  test("settingsForRuntime: trusted launch folder, untrusted second folder with a project .pi dir", () => {
    const dir = agentDir();
    const a = tmp("free-pi-trust-a-");
    const b = tmp("free-pi-trust-b-");
    mkdirSync(join(b, ".pi"), { recursive: true });
    writeFileSync(join(b, ".pi", "mcp.json"), "{}");
    const launch = { cwd: a, trusted: true };
    expect(settingsForRuntime(opts(dir), a, launch).isProjectTrusted()).toBe(true);
    expect(settingsForRuntime(opts(dir), b, launch).isProjectTrusted()).toBe(false);
    const plain = tmp("free-pi-trust-c-");
    expect(settingsForRuntime(opts(dir), plain, launch).isProjectTrusted()).toBe(true);
  });
});
