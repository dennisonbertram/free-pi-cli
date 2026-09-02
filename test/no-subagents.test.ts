// #28 R20/R20a: the explicit, tested no-subagent / no-second-concurrent-
// model-call guarantee. Two describe blocks:
//
//   SB1 (structural): buildRuntimeOptions()'s own output — the extension
//   list is closed, settings pin packages:[] / defaultTools, and the strict
//   `tools` allowlist is exactly SAFE_TOOLS plus the two legitimate custom
//   tools. Fails immediately if a future edit adds/renames an extension.
//
//   SB2 (dynamic): a REAL AgentSession, built from buildRuntimeOptions()'s
//   actual output (not a hand-rolled stand-in), driven through a real
//   multi-turn tool-calling conversation against a stub upstream. Proves
//   the shipped distro's own code path never has two completions requests
//   open at once, and every tool name it ever calls is in the allowed set.
//
// What this does NOT prove: that a user hasn't hand-edited their own local
// `~/.free-pi/agent/extensions/` directory (see the plan's Gap Analysis) —
// that is a client-machine trust boundary this project doesn't claim to
// close. R19 (the session lease, apps/server/src/agent-sessions.ts) is the
// server-side backstop for that residual case, not this test.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ALLOWED_TOOL_NAMES, buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { SAFE_TOOLS } from "../src/provider";
import { USAGE_TOOL_NAME } from "../src/usage-tool";
import { BUY_TOOL_NAME } from "../src/buy-tool";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function baseOpts(baseUrl: string): LaunchOptions {
  return { baseUrl, jwt: "test-jwt", agentDir: tempDir("free-pi-agentdir-") };
}

describe("closed extension list (#28 R20, SB1)", () => {
  test("buildRuntimeOptions registers exactly the seven known extensions — no more, no less", () => {
    const opts = buildRuntimeOptions(baseOpts("http://example.test"), "session-a");
    // #226: the closed set deliberately grew to six with free-pi-buy-tool;
    // 2026-09-01: to seven with free-pi-error-notice (one readable line on a
    // 429). Any further addition must be a reviewed, deliberate edit — never
    // accidental.
    expect([...opts.extensionNames].sort()).toEqual(
      [
        "free-pi-ads",
        "free-pi-buy-tool",
        "free-pi-commands",
        "free-pi-error-notice",
        "free-pi-provider",
        "free-pi-tool-guard",
        "free-pi-usage-tool",
      ].sort(),
    );
  });

  test("settings pin packages: [] and defaultTools to exactly SAFE_TOOLS", () => {
    const opts = buildRuntimeOptions(baseOpts("http://example.test"), "session-b");
    const settings = opts.settingsManager.getGlobalSettings();
    expect(settings.packages).toEqual([]);
    expect([...(settings.defaultTools ?? [])].sort()).toEqual([...SAFE_TOOLS].sort());
  });

  test("the strict SDK tools allowlist is exactly SAFE_TOOLS plus the two legitimate custom tools", () => {
    const opts = buildRuntimeOptions(baseOpts("http://example.test"), "session-c");
    expect([...opts.tools].sort()).toEqual([...SAFE_TOOLS, USAGE_TOOL_NAME, BUY_TOOL_NAME].sort());
  });

  test("SAFE_TOOLS / ALLOWED_TOOL_NAMES never contain a subagent/background-execution tool name", () => {
    const forbidden = ["subagent", "background_bash", "task", "agent", "sub_agent", "spawn_agent"];
    for (const name of forbidden) {
      expect(SAFE_TOOLS as readonly string[]).not.toContain(name);
      expect(ALLOWED_TOOL_NAMES).not.toContain(name);
    }
  });
});

// ---------------------------------------------------------------------------
// SB2: stub upstream shaped like the free-pi provider's own baseUrl
// (completionsBaseUrl appends /v1; the openai SDK inside pi-ai appends
// /chat/completions to that) — a raw OpenAI-completions-shaped streaming
// endpoint, scripted for exactly one tool call.
// ---------------------------------------------------------------------------

function sseFrame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/** Turn 1: an assistant message with one tool_call to "bash". */
function toolCallSse(): string {
  const start = {
    id: "resp-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek/deepseek-v4-flash",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "printf ok" }) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  const end = {
    id: "resp-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  };
  return sseFrame(start) + sseFrame(end) + "data: [DONE]\n\n";
}

/** Turn 2 (after the tool result comes back): plain text ending the turn. */
function finalTextSse(): string {
  const start = {
    id: "resp-2",
    object: "chat.completion.chunk",
    created: 2,
    model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }],
  };
  const end = {
    id: "resp-2",
    object: "chat.completion.chunk",
    created: 2,
    model: "deepseek/deepseek-v4-flash",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  };
  return sseFrame(start) + sseFrame(end) + "data: [DONE]\n\n";
}

describe("dynamic: a real multi-turn tool-calling AgentSession never opens a 2nd concurrent completion (#28 R20, SB2)", () => {
  test("drives buildRuntimeOptions()'s real production wiring against a stub upstream", async () => {
    let openCount = 0;
    let maxOpen = 0;
    let callCount = 0;
    const toolNamesSeen = new Set<string>();

    const stub = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
          return new Response("not found", { status: 404 });
        }
        openCount++;
        maxOpen = Math.max(maxOpen, openCount);
        try {
          const body = (await req.json()) as { messages?: Array<Record<string, unknown>> };
          for (const msg of body.messages ?? []) {
            const toolCalls = msg.tool_calls as Array<{ function?: { name?: string } }> | undefined;
            for (const tc of toolCalls ?? []) {
              if (tc.function?.name) toolNamesSeen.add(tc.function.name);
            }
          }
          const isFirstCall = callCount === 0;
          callCount++;
          // A short hold before responding: if the harness ever fired a
          // genuinely overlapping second request, it would land while this
          // one is still "open" and maxOpen would catch it.
          await Bun.sleep(15);
          const sse = isFirstCall ? toolCallSse() : finalTextSse();
          return new Response(sse, { headers: { "content-type": "text/event-stream" } });
        } finally {
          openCount--;
        }
      },
    });

    try {
      const baseUrl = stub.url.toString().replace(/\/$/, "");
      const cwd = tempDir("free-pi-cwd-");
      const opts: LaunchOptions = { baseUrl, jwt: "test-jwt", agentDir: tempDir("free-pi-agentdir-") };
      const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, "session-dyn-1");

      const services = await createAgentSessionServices({
        cwd,
        agentDir: opts.agentDir,
        settingsManager,
        resourceLoaderOptions,
      });
      const { session } = await createAgentSessionFromServices({
        services,
        sessionManager: SessionManager.inMemory(cwd),
        tools: [...tools],
      });

      try {
        await session.prompt("Run `printf ok` with the bash tool, then say you're done.");
      } finally {
        session.dispose();
      }

      expect(maxOpen).toBeLessThanOrEqual(1);
      expect(callCount).toBeGreaterThanOrEqual(1);
      // Sanity: the scripted tool call really happened — rules out a false
      // negative from the stub silently not being exercised.
      expect(toolNamesSeen.size).toBeGreaterThan(0);
      for (const name of toolNamesSeen) {
        expect(ALLOWED_TOOL_NAMES).toContain(name);
      }
    } finally {
      stub.stop(true);
    }
  }, 20_000);
});
