import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions } from "../src/pi-launch";

const server = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "stub-mcp-server.mjs");

/** Run one prompt against a stub upstream and return the tool names declared in the request. */
async function declaredTools(stubConfig: Record<string, unknown>): Promise<string[]> {
  let names: string[] = [];
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== "/v1/chat/completions") return new Response("nf", { status: 404 });
      const body = (await req.json()) as { tools?: Array<{ function: { name: string } }> };
      names = (body.tools ?? []).map((t) => t.function.name);
      const f = (c: unknown) => `data: ${JSON.stringify(c)}\n\n`;
      const base = { id: "r", object: "chat.completion.chunk", created: 1, model: "m" };
      return new Response(
        f({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] }) +
          f({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  try {
    const agentDir = mkdtempSync(join(tmpdir(), "free-pi-exposure-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "free-pi-exposure-cwd-"));
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [server], ...stubConfig } } }),
    );
    const baseUrl = stub.url.toString().replace(/\/$/, "");
    const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions({ baseUrl, jwt: "t", agentDir }, "exposure");
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions });
    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(cwd),
      tools: [...tools],
    });
    try {
      await session.bindExtensions({});
      await session.prompt("hi");
    } finally {
      session.dispose();
    }
    return names;
  } finally {
    stub.stop(true);
  }
}

describe("MCP exposure through the SDK tools list", () => {
  test('"exposure": "direct" declares the server\'s tools to the model', async () => {
    expect(await declaredTools({ exposure: "direct" })).toContain("mcp__stub__echo");
  }, 20_000);

  test("default (codemode) exposure does not declare the tools; codemode is declared", async () => {
    const names = await declaredTools({});
    expect(names).not.toContain("mcp__stub__echo");
    expect(names).toContain("codemode");
  }, 20_000);
});
