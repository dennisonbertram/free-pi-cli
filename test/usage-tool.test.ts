import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MeStatsResponse } from "@freepi/shared";
import { createUsageToolExtension, formatStats, percentUsed } from "../src/usage-tool";

// Mirrors packages/pi-ads/src/sandbox.test.ts's fake-ExtensionAPI Proxy
// harness: a Proxy that records every call instead of throwing on the
// unexpected ones, so a structural assertion ("only registerTool, nothing
// else") is meaningful rather than trivially true.
type ToolCall = {
  name: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

function createFakePi(): {
  pi: ExtensionAPI;
  onEvents: string[];
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const onEvents: string[] = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];

  const pi = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === "on") {
          return (event: string) => {
            onEvents.push(event);
          };
        }
        return (...args: unknown[]) => {
          calls.push({ method: prop, args });
          return undefined;
        };
      },
    },
  ) as unknown as ExtensionAPI;

  return { pi, onEvents, calls };
}

function registerAndGetTool(fetchImpl?: typeof fetch): ToolCall {
  const { pi, onEvents, calls } = createFakePi();
  const ext = createUsageToolExtension({
    baseUrl: "https://api.test",
    getToken: () => "jwt",
    fetchImpl,
  }) as { name: string; factory: (pi: ExtensionAPI) => void };
  ext.factory(pi);

  // R9 / structural: no event handler registered, and registerTool is the
  // only pi surface this extension ever touches.
  expect(onEvents).toEqual([]);
  expect(calls.every((c) => c.method === "registerTool")).toBe(true);
  expect(calls).toHaveLength(1);

  return calls[0]!.args[0] as ToolCall;
}

const STATS: MeStatsResponse = {
  user_id: "u1",
  handle: "octocat",
  tier: "young",
  cap_usd_today: 2,
  spent_usd_today: 0.5,
  remaining_usd_today: 1.5,
  credit_usd: 0,
  request_count_today: 3,
  prompt_tokens_today: 120,
  completion_tokens_today: 60,
  lifetime: { spent_usd: 4.2, prompt_tokens: 900, completion_tokens: 400, request_count: 12 },
};

describe("createUsageToolExtension", () => {
  test("registers exactly one read-only tool (name, empty parameter schema) and no event handlers", () => {
    const tool = registerAndGetTool();
    expect(tool.name).toBe("free_pi_usage");
    // R9: no argument exists that could mutate anything.
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  test("execute() against a stub returning a canned MeStatsResponse reports spend/remaining/tier", async () => {
    const fetchImpl = (async () => Response.json(STATS)) as unknown as typeof fetch;
    const tool = registerAndGetTool(fetchImpl);

    const result = await tool.execute("call-1", {}, undefined, undefined, {});
    expect(result.content[0]!.text).toContain("25% of your free daily allowance used"); // 0.5 of cap 2
    expect(result.content[0]!.text).not.toContain("$0.5"); // never a free-usage dollar figure
    expect(result.content[0]!.text).toContain("young"); // tier
    expect(result.details).toEqual(STATS);
  });

  test("free usage is shown as a percentage only — no free-usage dollar figure anywhere; credit stays in dollars", () => {
    // STATS: spent 0.5 of cap 2 → 25%.
    expect(formatStats({ ...STATS, credit_usd: 3.5 }).split("\n")).toEqual([
      "tier: young",
      "today: 25% of your free daily allowance used, 3 request(s)",
      "credit: $3.50 purchased usage remaining",
      "today tokens: 120 prompt / 60 completion",
      "lifetime: 12 request(s), 900 prompt / 400 completion tokens",
    ]);
    const { credit_usd: _omit, ...oldServer } = STATS;
    const without = formatStats(oldServer as MeStatsResponse);
    expect(without).not.toContain("credit");
    // Neither the cap, today's spend/remaining, nor lifetime spend appear as dollars.
    for (const s of [without, formatStats(STATS)]) {
      expect(s).not.toMatch(/\$2\.00|\$0\.5|\$1\.5|\$4\.2/);
    }
    expect(formatStats(STATS)).toContain("credit: $0.00 purchased usage remaining");
  });

  test("percentUsed rounds to a whole percent, clamps to 0..100, and treats a zero cap as fully used", () => {
    expect(percentUsed(0, 5)).toBe(0);
    expect(percentUsed(0.0023, 5)).toBe(0);
    expect(percentUsed(2.5, 5)).toBe(50);
    expect(percentUsed(4.976, 5)).toBe(100);
    expect(percentUsed(7, 5)).toBe(100);
    expect(percentUsed(1, 0)).toBe(100);
  });

  test("a non-OK response produces a graceful text result, not a thrown error", async () => {
    const fetchImpl = (async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    const tool = registerAndGetTool(fetchImpl);

    const result = await tool.execute("call-1", {}, undefined, undefined, {});
    expect(result.content[0]!.text).toContain("401");
    expect(result.details).toEqual({ ok: false });
  });

  test("a rejected fetch is caught and produces a graceful text result — execute() never throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const tool = registerAndGetTool(fetchImpl);

    let threw = false;
    let result: Awaited<ReturnType<ToolCall["execute"]>> | undefined;
    try {
      result = await tool.execute("call-1", {}, undefined, undefined, {});
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    expect(result?.details).toEqual({ ok: false });
  });
});
