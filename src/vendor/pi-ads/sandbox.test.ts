// KTD9 / R5 release gate: "Ad content never enters model context." This is
// the test the plan names as the release gate for the whole extension
// (bun test packages/pi-ads/src/sandbox.test.ts must pass before any
// publish). It proves two independent things:
//
//   1. Structural: the extension's registered hook surface (recorded via a
//      fake ExtensionAPI, using the same handler-registration shape pi's own
//      runner uses internally — `Map<eventName, handler[]>`) contains only
//      session_start / turn_end / session_shutdown. No context,
//      before_provider_request, before_agent_start, message_*, tool_*, or
//      agent_* handler is ever registered, so there is no code path from
//      which ad content could be spliced into a model request even in
//      principle.
//   2. Dynamic: with an active ad carrying a distinctive marker string, a
//      simulated session (session_start + several turn_end cycles) is driven
//      through the extension's real code. The marker is confirmed to reach
//      the UI layer (proving the stub is actually exercised, not a false
//      negative), the extension never calls any message-surface API
//      (sendMessage / sendUserMessage / appendEntry / registerTool /
//      registerMessageRenderer / registerEntryRenderer / registerCommand /
//      registerMarkdownTransformer), and a request payload run through this
//      extension's own (empty) context / before_provider_request handler
//      chains comes out byte-identical to the pristine fixture — the marker
//      never appears in it.
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAdsExtension } from "./index";

const MARKER = "ACME-SANDBOX-MARKER-9f3a";

type Handler = (event: unknown, ctx: unknown) => unknown;

function createFakePi(): {
  pi: ExtensionAPI;
  handlers: Map<string, Handler[]>;
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const handlers = new Map<string, Handler[]>();
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const pi = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "on") {
          return (event: string, handler: Handler) => {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
          };
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return undefined;
        };
      },
    },
  ) as unknown as ExtensionAPI;

  return { pi, handlers, calls };
}

function fakeCtx(): { ctx: ExtensionContext; widgetCalls: unknown[] } {
  const widgetCalls: unknown[] = [];
  const ui = {
    setWidget: (id: string, content: unknown, options?: unknown) => {
      widgetCalls.push({ id, content, options });
    },
    theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
  };
  const ctx = { ui } as unknown as ExtensionContext;
  return { ctx, widgetCalls };
}

function stubFetch(): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const url = new URL(input.toString());
    if (url.pathname === "/ads/next") {
      return Response.json({
        ad_id: "ad-1",
        click_token: `tok-${Math.random()}`,
        creative: {
          headline: `Try ${MARKER} today`,
          body: `${MARKER} is the best`,
          cta: "Learn more",
          accent: "#ff00ff",
        },
        click_url: "https://freepi.ai/c/tok-1",
      });
    }
    if (url.pathname === "/ads/impression") return Response.json({ ok: true });
    if (url.pathname === "/me") {
      return Response.json({ user_id: "u1", handle: "octocat", remaining_usd_today: 4.5 });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
}

describe("sandbox gate (KTD9 / R5) — ad content must never enter model context", () => {
  test("registers only UI-lifecycle hooks, and no ad content reaches a captured model request", async () => {
    const { pi, handlers, calls } = createFakePi();
    const { ctx, widgetCalls } = fakeCtx();

    const ext = createAdsExtension({
      baseUrl: "https://api.test",
      getToken: () => "jwt",
      sessionId: "session-test",
      fetchImpl: stubFetch(),
    }) as { name: string; factory: (pi: ExtensionAPI) => void };
    ext.factory(pi);

    // --- 1. Structural: exact hook surface ---
    expect([...handlers.keys()].sort()).toEqual(["session_shutdown", "session_start", "turn_end"]);

    const forbidden = [
      "context",
      "before_provider_request",
      "before_provider_headers",
      "after_provider_response",
      "before_agent_start",
      "agent_start",
      "agent_end",
      "agent_settled",
      "message_start",
      "message_update",
      "message_end",
      "tool_call",
      "tool_result",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "input",
      "user_bash",
      "model_select",
      "thinking_level_select",
    ];
    for (const event of forbidden) {
      expect(handlers.has(event)).toBe(false);
    }

    // --- 2. Dynamic: drive a simulated session with a marker-laden ad ---
    for (const handler of handlers.get("session_start") ?? []) {
      await handler({ type: "session_start", reason: "startup" }, ctx);
    }
    for (let i = 1; i <= 6; i++) {
      for (const handler of handlers.get("turn_end") ?? []) {
        await handler({ type: "turn_end", turnIndex: i, message: {}, toolResults: [] }, ctx);
      }
    }

    // Sanity: the marker really was served and really did reach the UI —
    // rules out a false negative from the stub silently not firing.
    expect(JSON.stringify(widgetCalls)).toContain(MARKER);

    // The extension never touches the message/session/tool surface.
    const messageSurfaceMethods = [
      "sendMessage",
      "sendUserMessage",
      "appendEntry",
      "registerTool",
      "registerMessageRenderer",
      "registerEntryRenderer",
      "registerMarkdownTransformer",
      "registerCommand",
    ];
    const messageSurfaceCalls = calls.filter((c) => messageSurfaceMethods.includes(c.method));
    expect(messageSurfaceCalls).toEqual([]);

    // --- 3. Capture: run a pristine request fixture through this
    // extension's own (empty) context / before_provider_request handler
    // chains, exactly as pi's runner would, and assert the marker never
    // appears in the result. ---
    let messages: unknown = [
      { role: "system", content: "You are a helpful coding agent." },
      { role: "user", content: "fix the failing test" },
    ];
    for (const handler of handlers.get("context") ?? []) {
      const result = (await handler({ type: "context", messages }, ctx)) as
        | { messages?: unknown }
        | undefined;
      if (result?.messages) messages = result.messages;
    }

    let payload: unknown = { model: "deepseek/deepseek-v4-flash", messages };
    for (const handler of handlers.get("before_provider_request") ?? []) {
      const result = await handler({ type: "before_provider_request", payload }, ctx);
      if (result !== undefined) payload = result;
    }

    expect(JSON.stringify(payload)).not.toContain(MARKER);
  });
});
