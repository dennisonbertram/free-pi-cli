// A real pi AgentSession built from buildRuntimeOptions(), against a stub
// upstream (no provider call). Proves the three efficiency changes in pi's own
// runtime rather than in isolation: the working rules and the long-jobs skill
// reach the system prompt, a user's APPEND_SYSTEM.md still loads beside them,
// and a bash call sent with `cmd` runs instead of failing validation.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";

const sse = (chunks: object[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const chunk = (delta: object, finish_reason: string | null) => ({
  id: "r",
  object: "chat.completion.chunk",
  created: 1,
  model: "deepseek/deepseek-v4-flash",
  choices: [{ index: 0, delta, finish_reason }],
});

test("rules, skill, user APPEND_SYSTEM.md and the cmd alias all work in a real session", async () => {
  const bodies: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  const stub = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/chat/completions") {
        return new Response("not found", { status: 404 });
      }
      bodies.push((await req.json()) as (typeof bodies)[number]);
      const body =
        bodies.length === 1
          ? sse([
              chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: JSON.stringify({ cmd: "printf alias-ok" }) } }] }, null),
              chunk({}, "tool_calls"),
            ])
          : sse([chunk({ role: "assistant", content: "done" }, null), chunk({}, "stop")]);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
  try {
    const cwd = mkdtempSync(join(tmpdir(), "free-pi-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "free-pi-agentdir-"));
    writeFileSync(join(agentDir, "APPEND_SYSTEM.md"), "USER-APPEND-MARKER");
    const opts: LaunchOptions = { baseUrl: stub.url.toString().replace(/\/$/, ""), jwt: "t", agentDir };
    const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, "s-eff");
    const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(cwd), tools: [...tools] });
    try {
      await session.prompt("go");
    } finally {
      session.dispose();
    }

    const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));
    const system = bodies[0]!.messages.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n");
    expect(system).toContain("## Working rules");
    expect(system).toContain("long-jobs");
    expect(system).toContain("USER-APPEND-MARKER");

    const toolResult = text(bodies[1]!.messages.find((m) => m.role === "tool")?.content);
    expect(toolResult).toContain("alias-ok");
    expect(toolResult).not.toContain("Validation failed");
  } finally {
    stub.stop(true);
  }
}, 20_000);
