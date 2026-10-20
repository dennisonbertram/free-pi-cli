import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createWebToolsExtension, DOCS_LOOKUP_GUIDELINES, WEB_SEARCH_GUIDELINES, DOCS_LOOKUP_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "../src/web-tools";

type Tool = {
  promptGuidelines?: string[];
  name: string;
  execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

function setup(fetchImpl: typeof fetch) {
  const tools: Record<string, Tool> = {};
  const pi = new Proxy({}, {
    get: (_t, prop: string) => (prop === "registerTool" ? (t: Tool) => { tools[t.name] = t; } : () => undefined),
  }) as unknown as ExtensionAPI;
  (createWebToolsExtension({ baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl }) as { factory: (p: ExtensionAPI) => void }).factory(pi);
  return tools;
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const run = (t: Tool, p: unknown) => t.execute("id", p, undefined, undefined, {});

describe("web_search", () => {
  test("posts query with bearer token and formats results without cost", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const tools = setup((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return json(200, { results: [{ title: "T1", url: "https://a.test", published_date: "2026-01-02", text: "body one" }, { title: "T2", url: "https://b.test", published_date: null, text: "body two" }], cost_usd: "0.007" });
    }) as unknown as typeof fetch);
    expect(Object.keys(tools).sort()).toEqual([DOCS_LOOKUP_TOOL_NAME, WEB_SEARCH_TOOL_NAME].sort());
    const r = await run(tools[WEB_SEARCH_TOOL_NAME]!, { query: "bun", num_results: 2 });
    expect(seen!.url).toBe("https://api.test/tools/web-search");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ query: "bun", num_results: 2 });
    const text = r.content[0]!.text;
    expect(text).toContain("1. T1");
    expect(text).toContain("https://a.test");
    expect(text).toContain("2026-01-02");
    expect(text).toContain("2. T2");
    expect(text).toContain("body two");
    expect(text).not.toContain("0.007");
    expect(JSON.stringify(r.details)).toContain("0.007");
  });

  test("429 daily_cap tells the model not to retry", async () => {
    const tools = setup((async () => json(429, { code: "daily_cap", message: "cap", error: { message: "cap" } })) as unknown as typeof fetch);
    const r = await run(tools[WEB_SEARCH_TOOL_NAME]!, { query: "x" });
    expect(r.content[0]!.text).toContain("daily free usage is used up");
    expect(r.content[0]!.text).toContain("Do not retry");
  });

  test("502 surfaces the server message", async () => {
    const tools = setup((async () => json(502, { code: "upstream_error", message: "search provider failed" })) as unknown as typeof fetch);
    const r = await run(tools[WEB_SEARCH_TOOL_NAME]!, { query: "x" });
    expect(r.content[0]!.text).toContain("search provider failed");
  });

  test("network error and timeout return text, never throw", async () => {
    const tools = setup((async () => { throw new Error("boom"); }) as unknown as typeof fetch);
    expect((await run(tools[WEB_SEARCH_TOOL_NAME]!, { query: "x" })).content[0]!.text).toContain("boom");
    const t2 = setup((async () => { throw new DOMException("t", "TimeoutError"); }) as unknown as typeof fetch);
    expect((await run(t2[WEB_SEARCH_TOOL_NAME]!, { query: "x" })).content[0]!.text).toContain("timed out");
  });
});

describe("docs_lookup", () => {
  test("forwards library_id, formats header and docs, hides cost", async () => {
    let body: unknown;
    let url = "";
    const tools = setup((async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(init.body as string);
      return json(200, { library_id: "/vercel/next.js", title: "Next.js", docs: "DOC TEXT", cost_usd: "0.001" });
    }) as unknown as typeof fetch);
    const r = await run(tools[DOCS_LOOKUP_TOOL_NAME]!, { library: "next.js", query: "routing", library_id: "/vercel/next.js" });
    expect(url).toBe("https://api.test/tools/docs");
    expect(body).toEqual({ library: "next.js", query: "routing", library_id: "/vercel/next.js" });
    const text = r.content[0]!.text;
    expect(text.split("\n")[0]).toContain("Next.js");
    expect(text.split("\n")[0]).toContain("/vercel/next.js");
    expect(text).toContain("DOC TEXT");
    expect(text).not.toContain("0.001");
  });

  test("503 and daily_cap come back as text", async () => {
    const t1 = setup((async () => json(503, { code: "not_configured", message: "not configured" })) as unknown as typeof fetch);
    expect((await run(t1[DOCS_LOOKUP_TOOL_NAME]!, { library: "a", query: "b" })).content[0]!.text).toContain("not available on this server");
    const t2 = setup((async () => json(429, { code: "daily_cap", message: "cap" })) as unknown as typeof fetch);
    expect((await run(t2[DOCS_LOOKUP_TOOL_NAME]!, { library: "a", query: "b" })).content[0]!.text).toContain("Do not retry");
  });
});

describe("model-facing text", () => {
  test("guidelines are registered on each tool", () => {
    const tools = setup((async () => json(200, {})) as unknown as typeof fetch);
    expect(tools[WEB_SEARCH_TOOL_NAME]!.promptGuidelines).toEqual(WEB_SEARCH_GUIDELINES);
    expect(tools[DOCS_LOOKUP_TOOL_NAME]!.promptGuidelines).toEqual(DOCS_LOOKUP_GUIDELINES);
    expect(WEB_SEARCH_GUIDELINES.join(" ")).toContain("daily allowance");
  });

  test("web_search output starts with a query header", async () => {
    const tools = setup((async () => json(200, { results: [{ title: "T", url: "https://a.test", published_date: null, text: "x" }], cost_usd: "0" })) as unknown as typeof fetch);
    expect((await run(tools[WEB_SEARCH_TOOL_NAME]!, { query: "q1" })).content[0]!.text.startsWith('Web results for "q1":')).toBe(true);
  });

  test("empty results text", async () => {
    const tools = setup((async () => json(200, { results: [], cost_usd: "0" })) as unknown as typeof fetch);
    expect((await run(tools[WEB_SEARCH_TOOL_NAME]!, { query: "zzz" })).content[0]!.text).toBe('No results for "zzz". Try a broader or differently worded query.');
  });

  const cases: Array<[number, string, string]> = [
    [429, "rolling_cap", "short-term usage limit is reached. Do not retry"],
    [429, "rate_limited", "Too many calls right now."],
    [404, "not_found", 'No documentation library matched "prisma". Retry once'],
    [503, "not_configured", "not available on this server. Do not call it again"],
    [502, "upstream_error", "The search provider failed. You may retry once."],
  ];
  for (const [status, code, expected] of cases) {
    test(`error code ${code}`, async () => {
      const tools = setup((async () => json(status, { code, message: "m" })) as unknown as typeof fetch);
      expect((await run(tools[DOCS_LOOKUP_TOOL_NAME]!, { library: "prisma", query: "q" })).content[0]!.text).toContain(expected);
    });
  }

  test("unknown code keeps the generic fallback with the server message", async () => {
    const tools = setup((async () => json(403, { code: "account_review", message: "under review" })) as unknown as typeof fetch);
    expect((await run(tools[WEB_SEARCH_TOOL_NAME]!, { query: "q" })).content[0]!.text).toBe("Request failed (HTTP 403): under review");
  });
});
