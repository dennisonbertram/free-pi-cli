import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MeResponse } from "@freepi/shared";
import { createBuyToolExtension } from "../src/buy-tool";

// Mirrors usage-tool.test.ts's fake-ExtensionAPI Proxy harness: a Proxy that
// records every call instead of throwing on the unexpected ones, so a
// structural assertion ("only registerTool, nothing else") is meaningful
// rather than trivially true.
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

type RecordedRequest = { url: string; method: string };

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

function registerAndGetTool(
  fetchImpl?: typeof fetch,
  openBrowserImpl?: (url: string) => void,
): ToolCall {
  const { pi, onEvents, calls } = createFakePi();
  const ext = createBuyToolExtension({
    baseUrl: "https://api.test",
    getToken: () => "jwt",
    fetchImpl,
    openBrowserImpl,
  }) as { name: string; factory: (pi: ExtensionAPI) => void };
  ext.factory(pi);

  // R9 / structural: no event handler registered, and registerTool is the
  // only pi surface this extension ever touches.
  expect(onEvents).toEqual([]);
  expect(calls.every((c) => c.method === "registerTool")).toBe(true);
  expect(calls).toHaveLength(1);

  return calls[0]!.args[0] as ToolCall;
}

function stubFetch(
  handler: (req: RecordedRequest) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const req: RecordedRequest = { url, method: init?.method ?? "GET" };
    requests.push(req);
    return handler(req);
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

const BUY_URL = "https://api.freepi.ai/buy?token=abc123";

const ME_WITH_BUY_URL: MeResponse = {
  user_id: "u1",
  handle: "octocat",
  remaining_usd_today: 0,
  cap_usd_today: 2,
  tier: "young",
  credit_usd: 0,
  buy_url: BUY_URL,
};

const ME_WITHOUT_BUY_URL: MeResponse = {
  user_id: "u1",
  handle: "octocat",
  remaining_usd_today: 1.5,
  cap_usd_today: 2,
  tier: "young",
  credit_usd: 0,
};

describe("createBuyToolExtension", () => {
  test("registers exactly one read-only tool (name, empty parameter schema) and no event handlers", () => {
    const tool = registerAndGetTool();
    expect(tool.name).toBe("free_pi_buy_credits");
    // R9: no argument exists that could mutate anything.
    expect(tool.parameters).toEqual({ type: "object", properties: {} });
  });

  test("buy_url present: opens the browser once with that URL and the returned text contains the URL", async () => {
    const { fetchImpl } = stubFetch(() => Response.json(ME_WITH_BUY_URL));
    const opened: string[] = [];
    const tool = registerAndGetTool(fetchImpl, (url) => {
      opened.push(url);
    });

    const result = await tool.execute("call-1", {}, undefined, undefined, {});
    expect(opened).toEqual([BUY_URL]);
    expect(result.content[0]!.text).toContain(BUY_URL);
    expect(result.details).toEqual({ buy_url: BUY_URL });
  });

  test("buy_url absent: returns the not-available text and never opens the browser", async () => {
    const { fetchImpl } = stubFetch(() => Response.json(ME_WITHOUT_BUY_URL));
    const opened: string[] = [];
    const tool = registerAndGetTool(fetchImpl, (url) => {
      opened.push(url);
    });

    const result = await tool.execute("call-1", {}, undefined, undefined, {});
    expect(opened).toEqual([]);
    expect(result.content[0]!.text).toBe("Buying credits is not available on this server yet.");
    expect(result.details).toEqual({ available: false });
  });

  test("a non-OK response produces a graceful text result, not a thrown error", async () => {
    const fetchImpl = (async () => new Response("server error", { status: 500 })) as unknown as typeof fetch;
    const tool = registerAndGetTool(fetchImpl);

    const result = await tool.execute("call-1", {}, undefined, undefined, {});
    expect(result.content[0]!.text).toContain("500");
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

  test("makes exactly one GET request to /me, no write request of any kind", async () => {
    const { fetchImpl, requests } = stubFetch(() => Response.json(ME_WITH_BUY_URL));
    const tool = registerAndGetTool(fetchImpl, () => {});

    await tool.execute("call-1", {}, undefined, undefined, {});
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("GET");
    expect(new URL(requests[0]!.url).pathname).toBe("/me");
  });
});
