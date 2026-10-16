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
  cap_usd_today: 1.125,
  spent_usd_today: 0.195,
  remaining_usd_today: 0.93,
  credit_usd: 0,
  credit_credits: 0,
  allowance_credits: 15_000,
  remaining_credits_today: 12_400,
  refill_at: "2026-10-15T00:00:00.000Z",
  lane: "standard",
  bonus_credits: 0,
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
    expect(result.content[0]!.text).toContain("12,400 / 15,000 credits left today");
    expect(result.content[0]!.text).not.toContain("$"); // never a free-usage dollar figure
    expect(result.content[0]!.text).toContain("young"); // tier
    expect(result.details).toEqual(STATS);
  });

  test("free usage is shown as credits left + refill — never a dollar figure", () => {
    expect(formatStats({ ...STATS, credit_credits: 50000 }).split("\n")).toEqual([
      "tier: young",
      "12,400 / 15,000 credits left today · refills 8:00 PM ET",
      "credit: 50,000 credits remaining",
      "today tokens: 120 prompt / 60 completion",
      "lifetime: 900 prompt / 400 completion tokens",
      "buy more credits: /buy-credits",
    ]);
    expect(formatStats({ ...STATS, lane: "fallback" })).toContain("Slow lane: cheapest model until refill");
    const { credit_credits: _omit, allowance_credits: _a, remaining_credits_today: _r, refill_at: _f, lane: _l, bonus_credits: _b, ...oldServer } = STATS;
    const without = formatStats(oldServer as MeStatsResponse);
    expect(without).not.toContain("credits remaining");
    expect(without.split("\n").at(-1)).toBe("buy more credits: /buy-credits");
    expect(without).toContain("17% of your free daily allowance used"); // 0.195 of 1.125
    for (const s of [without, formatStats(STATS)]) {
      expect(s).not.toMatch(/\$/);
    }
    expect(formatStats(STATS)).toContain("credit: 0 credits remaining");
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
