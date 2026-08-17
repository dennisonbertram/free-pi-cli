// #28 R20a: unit test for the tool-guard extension's handler. Same
// fake-ExtensionAPI technique packages/pi-ads/src/sandbox.test.ts already
// uses (a Proxy recording `.on()` registrations) — this file only needs the
// "tool_call" hook, not the full sandbox surface.
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { createToolGuardExtension } from "../src/tool-guard";

type Handler = (event: ToolCallEvent) => ToolCallEventResult | undefined | Promise<ToolCallEventResult | undefined>;

function createFakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]> } {
  const handlers = new Map<string, Handler[]>();
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
        return () => undefined;
      },
    },
  ) as unknown as ExtensionAPI;
  return { pi, handlers };
}

function toolCallEvent(toolName: string): ToolCallEvent {
  return { type: "tool_call", toolCallId: "call-1", toolName, input: {} } as unknown as ToolCallEvent;
}

describe("createToolGuardExtension (#28 R20a)", () => {
  test("registers only a tool_call handler", () => {
    const { pi, handlers } = createFakePi();
    const ext = createToolGuardExtension({
      baseUrl: "https://api.test",
      getToken: () => "jwt",
      allowedTools: ["bash", "read"],
    }) as { name: string; factory: (pi: ExtensionAPI) => void };

    expect(ext.name).toBe("free-pi-tool-guard");
    ext.factory(pi);
    expect([...handlers.keys()]).toEqual(["tool_call"]);
  });

  test("a call for an allowed tool name passes through untouched (no report)", async () => {
    const { pi, handlers } = createFakePi();
    let reported = false;
    const ext = createToolGuardExtension({
      baseUrl: "https://api.test",
      getToken: () => "jwt",
      allowedTools: ["bash", "read"],
      fetchImpl: (async () => {
        reported = true;
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    }) as { name: string; factory: (pi: ExtensionAPI) => void };
    ext.factory(pi);

    const result = await handlers.get("tool_call")![0]!(toolCallEvent("bash"));
    expect(result).toBeUndefined();
    expect(reported).toBe(false);
  });

  test("a call for a name outside allowedTools is blocked and reported exactly once", async () => {
    const { pi, handlers } = createFakePi();
    const reportedCalls: Array<{ url: string; body: unknown }> = [];
    const ext = createToolGuardExtension({
      baseUrl: "https://api.test",
      getToken: () => "jwt-abc",
      allowedTools: ["bash", "read"],
      fetchImpl: (async (url: string, init?: RequestInit) => {
        reportedCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    }) as { name: string; factory: (pi: ExtensionAPI) => void };
    ext.factory(pi);

    const result = await handlers.get("tool_call")![0]!(toolCallEvent("subagent"));
    // block, but NOT terminate — refuse the single rogue call, keep the session
    // alive (avoids a false-positive session-kill if the SDK ever emits a legit
    // tool under an unlisted name).
    expect(result).toEqual({
      block: true,
      reason: "tool not permitted in the free-pi distro",
    });

    // Reporting is fire-and-forget (void), so give the microtask queue a turn.
    await Promise.resolve();
    await Promise.resolve();
    expect(reportedCalls).toHaveLength(1);
    expect(reportedCalls[0]!.url).toBe("https://api.test/telemetry/tool-guard");
    expect(reportedCalls[0]!.body).toEqual({ tool_name: "subagent" });
  });

  test("a reporting failure never throws out of the handler (best-effort)", async () => {
    const { pi, handlers } = createFakePi();
    const ext = createToolGuardExtension({
      baseUrl: "https://api.test",
      getToken: () => "jwt",
      allowedTools: ["bash"],
      fetchImpl: (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch,
    }) as { name: string; factory: (pi: ExtensionAPI) => void };
    ext.factory(pi);

    const result = await handlers.get("tool_call")![0]!(toolCallEvent("subagent"));
    expect(result?.block).toBe(true);
  });
});
