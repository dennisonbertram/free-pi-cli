import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createImageToolExtension, IMAGE_TOOL_NAME } from "../src/image-tool";

type Tool = {
  name: string;
  description: string;
  promptGuidelines?: string[];
  execute: (id: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details: any }>;
};

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function setup(fetchImpl: typeof fetch) {
  const cwd = mkdtempSync(join(tmpdir(), "imgtool-"));
  dirs.push(cwd);
  const tools: Record<string, Tool> = {};
  const pi = new Proxy({}, {
    get: (_t, prop: string) => (prop === "registerTool" ? (t: Tool) => { tools[t.name] = t; } : () => undefined),
  }) as unknown as ExtensionAPI;
  (createImageToolExtension({ baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl, cwd }) as { factory: (p: ExtensionAPI) => void }).factory(pi);
  return { tool: tools[IMAGE_TOOL_NAME]!, cwd, tools };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5]);
const ok = (media_type = "image/jpeg", data: Buffer = bytes) => json(200, { image_b64: data.toString("base64"), media_type, cost_usd: "0.003", model: "m/x" });
const run = (t: Tool, p: unknown) => t.execute("id", p, undefined, undefined, {});
const files = (cwd: string) => (existsSync(join(cwd, "images")) ? readdirSync(join(cwd, "images")) : []);

describe("generate_image", () => {
  test("registers one tool with guidelines", () => {
    const { tools, tool } = setup((async () => ok()) as unknown as typeof fetch);
    expect(Object.keys(tools)).toEqual(["generate_image"]);
    expect(tool.promptGuidelines!.join(" ")).toContain("only when the user asks");
  });

  test("posts prompt and aspect ratio with bearer token, writes file, hides base64 and cost", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const { tool, cwd } = setup((async (url: string, init: RequestInit) => { seen = { url, init }; return ok(); }) as unknown as typeof fetch);
    const r = await run(tool, { prompt: "A red Fox!", aspect_ratio: "16:9", name: "ignored-for-body" });
    expect(seen!.url).toBe("https://api.test/tools/image");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
    expect(JSON.parse(seen!.init.body as string)).toEqual({ prompt: "A red Fox!", aspect_ratio: "16:9" });
    const [f] = files(cwd);
    expect(f).toMatch(/^ignored-for-body-[0-9a-f]{6}\.jpg$/);
    expect(readFileSync(join(cwd, "images", f!)).equals(bytes)).toBe(true);
    const text = r.content[0]!.text;
    expect(text).toContain(`images/${f}`);
    expect(text).toContain("cannot see");
    expect(text).toContain(`${bytes.length} bytes`);
    expect(text).not.toContain(bytes.toString("base64"));
    expect(text).not.toContain("0.003");
    expect(r.details).toEqual({ ok: true, path: `images/${f}`, cost_usd: "0.003", model: "m/x" });
    expect(JSON.stringify(r)).not.toMatch(/ad_|sponsor|advertis/i);
  });

  test.each([["image/png", "png"], ["image/jpeg", "jpg"], ["image/webp", "webp"]])("extension follows %s", async (mt, ext) => {
    const { tool, cwd } = setup((async () => ok(mt)) as unknown as typeof fetch);
    await run(tool, { prompt: "x" });
    expect(files(cwd)[0]).toMatch(new RegExp(`^x-[0-9a-f]{6}\\.${ext}$`));
  });

  test("slug comes from the prompt, falls back to image, and is capped", async () => {
    const { tool, cwd } = setup((async () => ok()) as unknown as typeof fetch);
    await run(tool, { prompt: "Hello, World! 123" });
    await run(tool, { prompt: "日本語!!!" });
    await run(tool, { prompt: "a".repeat(200) });
    const names = files(cwd).sort();
    expect(names.some((n) => n.startsWith("hello-world-123-"))).toBe(true);
    expect(names.some((n) => n.startsWith("image-"))).toBe(true);
    expect(names.every((n) => n.length <= 40 + 1 + 6 + 1 + 4)).toBe(true);
  });

  test("same name twice does not overwrite", async () => {
    const { tool, cwd } = setup((async () => ok()) as unknown as typeof fetch);
    await run(tool, { prompt: "p", name: "logo" });
    await run(tool, { prompt: "p", name: "logo" });
    expect(files(cwd).length).toBe(2);
  });

  test("path traversal in name stays inside images/", async () => {
    const { tool, cwd } = setup((async () => ok()) as unknown as typeof fetch);
    await run(tool, { prompt: "p", name: "../../x/../../etc/passwd" });
    expect(files(cwd).length).toBe(1);
    expect(files(cwd)[0]).not.toContain("/");
    expect(existsSync(join(cwd, "..", "x"))).toBe(false);
  });

  test("rejects unknown media types and oversized payloads without writing", async () => {
    const a = setup((async () => ok("text/html")) as unknown as typeof fetch);
    expect((await run(a.tool, { prompt: "p" })).content[0]!.text).toContain("unsupported");
    expect(files(a.cwd)).toEqual([]);
    const b = setup((async () => ok("image/png", Buffer.alloc(8 * 1024 * 1024 + 1))) as unknown as typeof fetch);
    expect((await run(b.tool, { prompt: "p" })).content[0]!.text).toContain("too large");
    expect(files(b.cwd)).toEqual([]);
  });

  test.each([
    ["daily_cap", "freepi.ai/extra-credits"],
    ["rolling_cap", "short-term"],
    ["rate_limited", "Too many"],
    ["not_configured", "not available"],
    ["upstream_error", "failed"],
    ["account_review", "review"],
    ["content_rejected", "rejected"],
  ])("error code %s maps to model text", async (code, frag) => {
    const { tool, cwd } = setup((async () => json(429, { error: { code, message: "m" } })) as unknown as typeof fetch);
    const r = await run(tool, { prompt: "p" });
    expect(r.content[0]!.text).toContain(frag);
    expect(r.details).toEqual({ ok: false });
    expect(files(cwd)).toEqual([]);
  });

  test("top-level code (web-tools shape) also maps", async () => {
    const { tool } = setup((async () => json(429, { code: "daily_cap" })) as unknown as typeof fetch);
    expect((await run(tool, { prompt: "p" })).content[0]!.text).toContain("extra-credits");
  });

  test("unknown error, network error and timeout return text, never throw", async () => {
    const a = setup((async () => json(500, { error: { code: "weird", message: "bad thing" } })) as unknown as typeof fetch);
    expect((await run(a.tool, { prompt: "p" })).content[0]!.text).toContain("bad thing");
    const b = setup((async () => { throw new Error("boom"); }) as unknown as typeof fetch);
    expect((await run(b.tool, { prompt: "p" })).content[0]!.text).toContain("boom");
    const c = setup((async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }) as unknown as typeof fetch);
    expect((await run(c.tool, { prompt: "p" })).content[0]!.text).toContain("120 seconds");
  });
});
