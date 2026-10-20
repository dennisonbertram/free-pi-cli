// Terminal-resize regression: the ad widgets must be laid out at the width pi
// gives them on every render, not at the terminal width seen at fetch time.
// (A card built for 160 columns and left in place wrapped into a broken frame
// when the pane shrank to 110, until the next ~10 minute banner refresh.)
import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth as piVisibleWidth } from "@earendil-works/pi-tui";
import { loadConfig } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { BANNER_WIDGET_ID, createBannerRenderer } from "./banner";
import { createInlineRenderer, INLINE_WIDGET_ID } from "./inline";

const config = loadConfig({});
const AD = {
  ad_id: "ad-1",
  click_token: "tok-1",
  creative: {
    headline: "MongoDB",
    body: "Build AI agents with MongoDB Agent Skills to design schemas and query data using natural language.",
    cta: "Start Building",
    accent: "#00ff88",
  },
  click_url: "https://freepi.ai/c/tok-1",
};
const fetchImpl = (async (input: string) => {
  const url = new URL(input.toString());
  if (url.pathname === "/ads/next") return Response.json(AD);
  return Response.json({ ok: true });
}) as unknown as typeof fetch;
const deps: AdsDeps = { baseUrl: "https://api.test", getToken: () => "jwt", sessionId: "s", fetchImpl };
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };

function fakeCtx() {
  const widgets = new Map<string, unknown>();
  const ctx = {
    ui: {
      setWidget: (id: string, content: unknown) => (content === undefined ? widgets.delete(id) : widgets.set(id, content)),
      theme,
    },
  } as unknown as ExtensionContext;
  return { ctx, widgets };
}

/** Fetch happens while the terminal is 160 columns wide; the old code froze that width into the lines. */
async function fetchedAt160(run: () => Promise<void>) {
  const prev = process.stdout.columns;
  process.stdout.columns = 160;
  try {
    await run();
  } finally {
    process.stdout.columns = prev as number;
  }
}

/** What pi draws at `width`: a widget factory is rendered at that width; a static string[] is drawn as-is. */
function drawAt(content: unknown, width: number): string[] {
  if (typeof content === "function") {
    return (content(undefined, theme) as { render(w: number): string[] }).render(width);
  }
  return content as string[];
}

// OSC 8 link escapes take no columns. Every glyph the card uses is one column wide.
const visibleWidth = (s: string) => [...s.replace(/\x1b\]8;[^\x07]*\x07/g, "")].length;

for (const [name, widgetId, show] of [
  ["banner", BANNER_WIDGET_ID, (ctx: ExtensionContext) => createBannerRenderer().render(deps, ctx, config)],
  ["inline", INLINE_WIDGET_ID, async (ctx: ExtensionContext) => {
    const inline = createInlineRenderer();
    for (let i = 0; i < config.adInlineTurnFrequency; i++) await inline.onTurnEnd(deps, ctx, config);
  }],
] as const) {
  describe(`${name} widget follows the width pi renders it at`, () => {
    test("shrinking 160 -> 110 keeps every line within 110 columns with aligned borders", async () => {
      const { ctx, widgets } = fakeCtx();
      await fetchedAt160(() => show(ctx));
      const content = widgets.get(widgetId);

      const wide = drawAt(content, 160);
      expect(Math.max(...wide.map(visibleWidth))).toBeLessThanOrEqual(160);

      const narrow = drawAt(content, 110);
      expect(narrow.length).toBe(5);
      expect(Math.max(...narrow.map(visibleWidth))).toBeLessThanOrEqual(110);
      expect(new Set(narrow.map(visibleWidth)).size).toBe(1); // top, rows, bottom all the same width
    });

    test("growing 110 -> 160 fills the new width again", async () => {
      const { ctx, widgets } = fakeCtx();
      await fetchedAt160(() => show(ctx));
      const content = widgets.get(widgetId);
      const narrow = Math.max(...drawAt(content, 110).map(visibleWidth));
      const wide = drawAt(content, 160);
      expect(Math.max(...wide.map(visibleWidth))).toBeGreaterThan(narrow);
      expect(Math.max(...wide.map(visibleWidth))).toBeLessThanOrEqual(160);
    });

    test("below adMinColumns the same widget falls back to one plain line that fits", async () => {
      const { ctx, widgets } = fakeCtx();
      await fetchedAt160(() => show(ctx));
      const content = widgets.get(widgetId);
      expect(drawAt(content, 100).length).toBe(5); // framed card at 100
      const plain = drawAt(content, config.adMinColumns - 1);
      expect(plain.length).toBe(1);
      expect(plain[0]).not.toContain("┌");
      expect(visibleWidth(plain[0]!)).toBeLessThanOrEqual(config.adMinColumns - 1);
    });
  });
}

describe("widget keeps sanitizing and linking ad text at render time", () => {
  test("escape sequences in ad copy never reach the drawn lines; every card line is still one OSC 8 link", async () => {
    const evil = { ...AD, creative: { ...AD.creative, headline: "Hi\x1b[2J\x1b]0;pwned\x07there", body: "a\x1b]8;;http://evil\x07b" } };
    const evilFetch = (async (input: string) =>
      new URL(input.toString()).pathname === "/ads/next" ? Response.json(evil) : Response.json({ ok: true })) as unknown as typeof fetch;
    const { ctx, widgets } = fakeCtx();
    await createBannerRenderer().render({ ...deps, fetchImpl: evilFetch }, ctx, config);

    const lines = drawAt(widgets.get(BANNER_WIDGET_ID), 100);
    const joined = lines.join("\n");
    expect(joined).not.toContain("pwned");
    expect(joined).not.toContain("evil");
    expect(joined).not.toContain("\x1b[");
    for (const line of lines) {
      // only the card's own OSC 8 open/close pair per line, pointing at the click URL
      expect(line.match(/\x1b\]8;/g)?.length).toBe(2);
      expect(line).toContain(AD.click_url);
    }
  });
});

describe("a fetched ad with wide characters stays inside pi's width", () => {
  test("banner with a CJK headline at width 80: no line exceeds 80 cells (pi throws past that)", async () => {
    const cjk = { ...AD, creative: { ...AD.creative, headline: "界".repeat(40), body: "データベース".repeat(15) } };
    const cjkFetch = (async (input: string) =>
      new URL(input.toString()).pathname === "/ads/next" ? Response.json(cjk) : Response.json({ ok: true })) as unknown as typeof fetch;
    const { ctx, widgets } = fakeCtx();
    await createBannerRenderer().render({ ...deps, fetchImpl: cjkFetch }, ctx, config);

    const lines = drawAt(widgets.get(BANNER_WIDGET_ID), 80);
    expect(lines.length).toBe(5);
    expect(Math.max(...lines.map(piVisibleWidth))).toBeLessThanOrEqual(80);
    expect(new Set(lines.map(piVisibleWidth)).size).toBe(1);
  });
});
