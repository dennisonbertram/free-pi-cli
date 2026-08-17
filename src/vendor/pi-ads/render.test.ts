import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { BANNER_WIDGET_ID, createBannerRenderer } from "./banner";
import { inferErrorFromRemainingBudget, mapErrorCode } from "./errors";
import { createInlineRenderer, INLINE_WIDGET_ID } from "./inline";
import { sanitizeText } from "./style";

const config = loadConfig({}); // defaults: adInlineTurnFrequency=5, adMinColumns=60

interface WidgetCall {
  id: string;
  content: unknown;
  options?: unknown;
}

function fakeCtx(): { ctx: ExtensionContext; widgetCalls: WidgetCall[] } {
  const widgetCalls: WidgetCall[] = [];
  const ui = {
    setWidget: (id: string, content: unknown, options?: unknown) => {
      widgetCalls.push({ id, content, options });
    },
    theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
  };
  const ctx = { ui } as unknown as ExtensionContext;
  return { ctx, widgetCalls };
}

function jsonResponse(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status: 204 });
  return Response.json(body, { status });
}

const AD_BODY = {
  ad_id: "ad-1",
  click_token: "tok-1",
  creative: { headline: "Headline", body: "Body copy", cta: "Click here", accent: "#fff" },
  click_url: "https://freepi.ai/c/tok-1",
};

function deps(fetchImpl: typeof fetch): AdsDeps {
  return { baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl };
}

// ---------------------------------------------------------------------------
// (2) Sanitizer
// ---------------------------------------------------------------------------

describe("sanitizeText", () => {
  test("strips an OSC title-injection sequence", () => {
    expect(sanitizeText("\x1b]0;title\x07Buy now")).toBe("Buy now");
  });

  test("strips CSI (ANSI color) sequences", () => {
    expect(sanitizeText("\x1b[31mRED\x1b[0m text")).toBe("RED text");
  });

  test("strips raw C0 control characters and lone ESC bytes", () => {
    expect(sanitizeText("a\x00b\x07c\x1bd")).toBe("abcd");
  });

  test("collapses embedded newlines/tabs to a single space", () => {
    expect(sanitizeText("line one\nline\ttwo")).toBe("line one line two");
  });
});

// ---------------------------------------------------------------------------
// (3) Inline cadence: turns 5 and 10, not 1-4
// ---------------------------------------------------------------------------

describe("inline cadence", () => {
  test("ad card appears on turn 5 and 10, not on 1-4", async () => {
    let impressionCalls = 0;
    let nextCalls = 0;
    const fetchImpl = (async (input: string) => {
      const url = new URL(input.toString());
      // /ads/next always mints a fresh click_token server-side — mirror that
      // here so turn 5 and turn 10 are two genuinely distinct impressions,
      // not a repaint.
      if (url.pathname === "/ads/next") {
        nextCalls += 1;
        return jsonResponse({ ...AD_BODY, click_token: `tok-${nextCalls}` });
      }
      if (url.pathname === "/ads/impression") {
        impressionCalls += 1;
        return jsonResponse({ ok: true });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const inline = createInlineRenderer();
    const { ctx, widgetCalls } = fakeCtx();

    for (let turn = 1; turn <= 4; turn++) {
      await inline.onTurnEnd(deps(fetchImpl), ctx, config, 80);
    }
    expect(widgetCalls.length).toBe(0);

    await inline.onTurnEnd(deps(fetchImpl), ctx, config, 80); // turn 5
    expect(widgetCalls.length).toBe(1);
    expect(widgetCalls[0]?.id).toBe(INLINE_WIDGET_ID);
    expect(widgetCalls[0]?.content).not.toBeUndefined();

    for (let turn = 6; turn <= 9; turn++) {
      await inline.onTurnEnd(deps(fetchImpl), ctx, config, 80);
    }
    // turn 6 clears the turn-5 card; turns 7-9 are no-ops.
    expect(widgetCalls.length).toBe(2);
    expect(widgetCalls[1]?.content).toBeUndefined();

    await inline.onTurnEnd(deps(fetchImpl), ctx, config, 80); // turn 10
    expect(widgetCalls.length).toBe(3);
    expect(widgetCalls[2]?.content).not.toBeUndefined();

    expect(impressionCalls).toBe(2); // one per distinct ad shown (turn 5, turn 10)
  });
});

// ---------------------------------------------------------------------------
// (4) 204 / fetch-failure -> no widget content
// ---------------------------------------------------------------------------

describe("banner: empty slot and fetch failure", () => {
  test("204 (no active ad) clears the widget", async () => {
    const fetchImpl = (async () => jsonResponse(null, 204)) as unknown as typeof fetch;
    const banner = createBannerRenderer();
    const { ctx, widgetCalls } = fakeCtx();

    await banner.render(deps(fetchImpl), ctx, config, 80);

    expect(widgetCalls.length).toBe(1);
    expect(widgetCalls[0]?.id).toBe(BANNER_WIDGET_ID);
    expect(widgetCalls[0]?.content).toBeUndefined();
  });

  test("a fetch failure clears the widget and never throws", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const banner = createBannerRenderer();
    const { ctx, widgetCalls } = fakeCtx();

    await banner.render(deps(fetchImpl), ctx, config, 80);

    expect(widgetCalls.length).toBe(1);
    expect(widgetCalls[0]?.content).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// (5) Impression POST fires once per rendered ad, not per repaint
// ---------------------------------------------------------------------------

describe("impression tracking", () => {
  test("re-rendering the same fetched ad does not double-post the impression", async () => {
    let impressionCalls = 0;
    const fetchImpl = (async (input: string) => {
      const url = new URL(input.toString());
      if (url.pathname === "/ads/next") return jsonResponse(AD_BODY); // same click_token every time
      if (url.pathname === "/ads/impression") {
        impressionCalls += 1;
        return jsonResponse({ ok: true });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    const banner = createBannerRenderer();
    const { ctx } = fakeCtx();

    await banner.render(deps(fetchImpl), ctx, config, 80);
    await banner.render(deps(fetchImpl), ctx, config, 80); // repaint: same ad, same click_token

    expect(impressionCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (6) Narrow terminal (<60 cols) -> plain single line
// ---------------------------------------------------------------------------

describe("narrow terminal fallback", () => {
  test("below adMinColumns renders a single plain line, no frame", async () => {
    const fetchImpl = (async (input: string) => {
      const url = new URL(input.toString());
      if (url.pathname === "/ads/next") return jsonResponse(AD_BODY);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const banner = createBannerRenderer();
    const { ctx, widgetCalls } = fakeCtx();

    await banner.render(deps(fetchImpl), ctx, config, 40); // < adMinColumns (60)

    const lines = widgetCalls[0]?.content as string[];
    expect(lines.length).toBe(1);
    expect(lines[0]).not.toContain("┌");
    expect(lines[0]).not.toContain("│");
  });

  test("at or above adMinColumns renders the framed multi-line card", async () => {
    const fetchImpl = (async (input: string) => {
      const url = new URL(input.toString());
      if (url.pathname === "/ads/next") return jsonResponse(AD_BODY);
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    const banner = createBannerRenderer();
    const { ctx, widgetCalls } = fakeCtx();

    await banner.render(deps(fetchImpl), ctx, config, 80);

    const lines = widgetCalls[0]?.content as string[];
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("┌");
  });
});

// ---------------------------------------------------------------------------
// (7) Error-code mapping
// ---------------------------------------------------------------------------

describe("mapErrorCode", () => {
  test("daily_cap contains the exact reset-time message", () => {
    expect(mapErrorCode("daily_cap")).toBe("out of free tokens today, resets at 00:00 UTC");
  });

  test("every error code maps to a non-empty message", () => {
    const codes = [
      "daily_cap",
      "concurrent",
      "context_ceiling",
      "upstream_error",
      "global_cap",
      "consent_required",
    ] as const;
    for (const code of codes) {
      expect(mapErrorCode(code).length).toBeGreaterThan(0);
    }
  });
});

describe("inferErrorFromRemainingBudget", () => {
  test("exhausted or negative budget infers daily_cap", () => {
    expect(inferErrorFromRemainingBudget(0)).toBe("daily_cap");
    expect(inferErrorFromRemainingBudget(-0.01)).toBe("daily_cap");
  });

  test("positive remaining budget infers no error", () => {
    expect(inferErrorFromRemainingBudget(1.23)).toBeUndefined();
  });
});
