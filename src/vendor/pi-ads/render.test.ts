import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@freepi/shared";
import { fetchAdNext, postImpression, type AdsDeps } from "./api";
import { BANNER_WIDGET_ID, createBannerRenderer } from "./banner";
import { inferErrorFromRemainingBudget, mapErrorCode } from "./errors";
import { createInlineRenderer, INLINE_WIDGET_ID } from "./inline";
import { CONFIRM_TURNS, LOW_CREDIT_FRACTION, creditAddedMessage, METER_STATUS_KEY, METER_WIDGET_ID, renderMeter, resetMeterState } from "./meter";
import { renderAdCard, renderPlainAdLine, sanitizeText } from "./style";

const config = loadConfig({}); // defaults: adInlineTurnFrequency=5, adMinColumns=60

interface WidgetCall {
  id: string;
  content: unknown;
  options?: unknown;
}

function fakeCtx(): { ctx: ExtensionContext; widgetCalls: WidgetCall[]; statusCalls: { key: string; text: string | undefined }[] } {
  const widgetCalls: WidgetCall[] = [];
  const statusCalls: { key: string; text: string | undefined }[] = [];
  const ui = {
    setStatus: (key: string, text: string | undefined) => {
      statusCalls.push({ key, text });
    },
    setWidget: (id: string, content: unknown, options?: unknown) => {
      widgetCalls.push({ id, content, options });
    },
    theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
  };
  const ctx = { ui } as unknown as ExtensionContext;
  return { ctx, widgetCalls, statusCalls };
}

/** What pi draws for a widget at `width`: ad widgets are factories that render at the live width. */
function drawAt(content: unknown, width: number): string[] {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  return (content as (tui: unknown, theme: unknown) => { render(w: number): string[] })(undefined, theme).render(width);
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
  return { baseUrl: "https://api.test", getToken: () => "jwt", sessionId: "session-test", fetchImpl };
}

describe("session lease headers", () => {
  test("sends the stable session id on ad next and impression requests", async () => {
    const headers: Headers[] = [];
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
      headers.push(new Headers(init?.headers));
      return jsonResponse(AD_BODY);
    }) as unknown as typeof fetch;

    await fetchAdNext(deps(fetchImpl), "banner");
    await postImpression(deps(fetchImpl), AD_BODY.ad_id, AD_BODY.click_token);

    expect(headers).toHaveLength(2);
    expect(headers[0]?.get("x-session-id")).toBe("session-test");
    expect(headers[1]?.get("x-session-id")).toBe("session-test");
  });
});

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
      // /ads/next always mints a fresh click_token server-side (see
      // apps/server/src/routes/ads.ts) — mirror that here so turn 5 and
      // turn 10 are two genuinely distinct impressions, not a repaint.
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
      await inline.onTurnEnd(deps(fetchImpl), ctx, config);
    }
    expect(widgetCalls.length).toBe(0);

    await inline.onTurnEnd(deps(fetchImpl), ctx, config); // turn 5
    expect(widgetCalls.length).toBe(1);
    expect(widgetCalls[0]?.id).toBe(INLINE_WIDGET_ID);
    expect(widgetCalls[0]?.content).not.toBeUndefined();

    for (let turn = 6; turn <= 9; turn++) {
      await inline.onTurnEnd(deps(fetchImpl), ctx, config);
    }
    // turn 6 clears the turn-5 card; turns 7-9 are no-ops.
    expect(widgetCalls.length).toBe(2);
    expect(widgetCalls[1]?.content).toBeUndefined();

    await inline.onTurnEnd(deps(fetchImpl), ctx, config); // turn 10
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

    await banner.render(deps(fetchImpl), ctx, config);

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

    await banner.render(deps(fetchImpl), ctx, config);

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

    await banner.render(deps(fetchImpl), ctx, config);
    await banner.render(deps(fetchImpl), ctx, config); // repaint: same ad, same click_token

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

    await banner.render(deps(fetchImpl), ctx, config);

    const lines = drawAt(widgetCalls[0]?.content, 40); // < adMinColumns (60)
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

    await banner.render(deps(fetchImpl), ctx, config);

    const lines = drawAt(widgetCalls[0]?.content, 80);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("┌");
  });
});

// ---------------------------------------------------------------------------
// (7) Error-code mapping
// ---------------------------------------------------------------------------

describe("mapErrorCode", () => {
  test("daily_cap contains the exact reset-time message", () => {
    expect(mapErrorCode("daily_cap")).toBe("out of free credits today — refills at UTC midnight");
    expect(mapErrorCode("queue_wait")).toBe("free-pi is near its daily budget — wait and retry");
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

// ---------------------------------------------------------------------------
// (8) #61: link the CTA, never show the raw /c/<token> tracker as visible text
// ---------------------------------------------------------------------------

describe("#61 ad link: CTA visible, tracker URL only as the OSC-8 target", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const creative = { headline: "H", body: "B", cta: "get the skill @ slop.cash", accent: "#fff" };
  const clickUrl = "https://api.freepi.ai/c/8eb56276-fda6-4aae-a800-b40ad39abcde";
  // Strip OSC-8 open (`ESC ] 8 ; [id=..];  <url> BEL`) + close so only visible text remains.
  const stripOsc8 = (s: string) => s.replace(/\x1b\]8;[^;\x07]*;[^\x07]*\x07/g, "");

  test("framed card shows the CTA, hides the raw tracker, keeps the link target", () => {
    const lines = renderAdCard(creative, clickUrl, theme, 80);
    const joined = lines.join("\n");
    const visible = stripOsc8(joined);
    expect(visible).toContain("get the skill @ slop.cash");
    expect(visible).not.toContain("/c/");
    expect(visible).not.toContain(clickUrl);
    expect(joined).toContain(`;${clickUrl}\x07`); // still clickable/tracked
  });

  test("narrow plain line does the same", () => {
    const line = renderPlainAdLine(creative, clickUrl, theme, 80);
    const visible = stripOsc8(line);
    expect(visible).toContain("get the skill @ slop.cash");
    expect(visible).not.toContain("/c/");
    expect(line).toContain(`\x1b]8;;${clickUrl}\x07`);
  });
});

// ---------------------------------------------------------------------------
// U1: whole card is one OSC 8 link with a shared id (R1, R2, R3, R4)
// ---------------------------------------------------------------------------

describe("U1: whole ad card is one clickable link", () => {
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const creative = { headline: "Headline", body: "Body copy", cta: "Click here", accent: "#fff" };
  const clickUrl = "https://api.freepi.ai/c/tok";
  const stripOsc8 = (s: string) => s.replace(/\x1b\]8;[^;\x07]*;[^\x07]*\x07/g, "");
  const idOf = (line: string): string => {
    const m = line.match(/\x1b\]8;id=([0-9a-f]+);/);
    if (!m) throw new Error(`no OSC 8 id found in: ${JSON.stringify(line)}`);
    return m[1]!;
  };

  test("every one of the five lines carries the same id and the click URL, plus a close sequence", () => {
    const lines = renderAdCard(creative, clickUrl, theme, 80);
    expect(lines.length).toBe(5);
    const ids = lines.map(idOf);
    expect(new Set(ids).size).toBe(1);
    for (const line of lines) {
      expect(line).toContain(`;${clickUrl}\x07`);
      expect(line).toContain("\x1b]8;;\x07"); // close sequence
    }
  });

  test("the id is stable across two renders of the same URL and differs for a different URL", () => {
    const idA1 = idOf(renderAdCard(creative, clickUrl, theme, 80)[0]!);
    const idA2 = idOf(renderAdCard(creative, clickUrl, theme, 80)[0]!);
    const idB = idOf(renderAdCard(creative, "https://api.freepi.ai/c/other", theme, 80)[0]!);
    expect(idA1).toBe(idA2);
    expect(idA1).not.toBe(idB);
  });

  test("visible text with escapes stripped is byte-identical to the pre-change output at 60, 80, 140 cols", () => {
    const expected: Record<number, string[]> = {
      60: [
        "┌ AD ░▒▓ ────────────────────────────────────────────────┐",
        "│ Headline                                               │",
        "│ Body copy                                              │",
        "│ ▸ Click here                                           │",
        "└────────────────────────────────────────────────────────┘",
      ],
      80: [
        "┌ AD ░▒▓ ────────────────────────────────────────────────────────────────────┐",
        "│ Headline                                                                   │",
        "│ Body copy                                                                  │",
        "│ ▸ Click here                                                               │",
        "└────────────────────────────────────────────────────────────────────────────┘",
      ],
      140: [
        "┌ AD ░▒▓ ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐",
        "│ Headline                                                                                                                               │",
        "│ Body copy                                                                                                                              │",
        "│ ▸ Click here                                                                                                                           │",
        "└────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘",
      ],
    };
    for (const width of [60, 80, 140] as const) {
      const lines = renderAdCard(creative, clickUrl, theme, width).map(stripOsc8);
      expect(lines).toEqual(expected[width]!);
    }
  });

  test("the CTA text is still visible and the raw /c/ URL is still not visible", () => {
    const lines = renderAdCard(creative, clickUrl, theme, 80).map(stripOsc8);
    const joined = lines.join("\n");
    expect(joined).toContain("Click here");
    expect(joined).not.toContain("/c/");
  });

  test("renderPlainAdLine output is unchanged (still the id-less single-URL form)", () => {
    const line = renderPlainAdLine(creative, clickUrl, theme, 80);
    expect(line).toContain(`\x1b]8;;${clickUrl}\x07`);
    expect(line).not.toMatch(/\x1b\]8;id=/);
  });

  test("a creative with an injected OSC 8 sequence in the headline is sanitized: no second link target appears", () => {
    const evilCreative = { ...creative, headline: "hi\x1b]8;;evil\x07click\x1b]8;;\x07" };
    const lines = renderAdCard(evilCreative, clickUrl, theme, 80);
    const joined = lines.join("\n");
    expect(joined).not.toContain("evil");
    // exactly one distinct link target across the whole card: the click URL.
    const targets = new Set([...joined.matchAll(/\x1b\]8;[^;\x07]*;([^\x07]*)\x07/g)].map((m) => m[1]).filter((t) => t));
    expect(targets).toEqual(new Set([clickUrl]));
  });
});

describe("meter: server-supplied notice (#225)", () => {
  function meFetch(body: Record<string, unknown>): typeof fetch {
    return (async () => jsonResponse({ user_id: "u1", handle: "octocat", cap_usd_today: 5, tier: "established", ...body })) as unknown as typeof fetch;
  }

  test("a non-empty notice is rendered verbatim as the widget's one line, even with budget left", async () => {
    const { ctx, widgetCalls } = fakeCtx();
    const notice = "out of free usage today (established tier). Buy more at https://api.test/buy/tok — $5 or $10, card or USDC. Free usage resets at 00:00 UTC.";
    await renderMeter(deps(meFetch({ remaining_usd_today: 0, notice })), ctx);
    expect(widgetCalls).toEqual([{ id: METER_WIDGET_ID, content: [notice], options: undefined }]);
  });

  test("a notice is plain text: terminal control sequences are stripped, never interpreted", async () => {
    const { ctx, widgetCalls } = fakeCtx();
    await renderMeter(deps(meFetch({ remaining_usd_today: 0, notice: "buy \u001b]0;pwned\u0007more \u001b[31mnow\u001b[0m" })), ctx);
    expect(widgetCalls[0]!.content).toEqual(["buy more now"]);
  });

  test("no notice + exhausted budget → the baked daily_cap string, byte-identical to before", async () => {
    const { ctx, widgetCalls } = fakeCtx();
    await renderMeter(deps(meFetch({ remaining_usd_today: 0 })), ctx);
    expect(widgetCalls).toEqual([{ id: METER_WIDGET_ID, content: [mapErrorCode("daily_cap")], options: undefined }]);
  });

  test("no notice (or an empty one) + budget left on an old server → no widget, as before", async () => {
    for (const body of [{ remaining_usd_today: 4.5 }, { remaining_usd_today: 4.5, notice: "" }, { remaining_usd_today: 4.5, notice: "   " }]) {
      const { ctx, widgetCalls } = fakeCtx();
      await renderMeter(deps(meFetch(body)), ctx);
      expect(widgetCalls).toEqual([{ id: METER_WIDGET_ID, content: undefined, options: undefined }]);
    }
  });

  test("Phase 0: standard lane shows only the remaining credits in the footer status, no widget", async () => {
    const { ctx, widgetCalls, statusCalls } = fakeCtx();
    await renderMeter(
      deps(
        meFetch({
          remaining_usd_today: 0.93,
          allowance_credits: 15_000,
          remaining_credits_today: 14_984,
          refill_at: "2026-10-15T00:00:00.000Z",
          lane: "standard",
        }),
      ),
      ctx,
    );
    expect(statusCalls.at(-1)).toEqual({ key: METER_STATUS_KEY, text: "14,984 credits" });
    expect(widgetCalls).toEqual([{ id: METER_WIDGET_ID, content: undefined, options: undefined }]);
  });

  test("Phase 0: standard lane footer adds purchased credits when bonus_credits > 0", async () => {
    const run = async (extra: Record<string, unknown>) => {
      const { ctx, statusCalls } = fakeCtx();
      await renderMeter(
        deps(meFetch({ remaining_usd_today: 0.93, allowance_credits: 15_000, remaining_credits_today: 14_613,
          refill_at: "2026-10-15T00:00:00.000Z", lane: "standard", ...extra })),
        ctx,
      );
      return statusCalls.at(-1)!.text;
    };
    expect(await run({ bonus_credits: 100_000 })).toBe("14,613 + 100,000 credits");
    expect(await run({ bonus_credits: 0 })).toBe("14,613 credits");
    expect(await run({})).toBe("14,613 credits");
  });

  test("Phase 0: fallback lane shows '0 credits · slow lane' in the footer, no widget", async () => {
    const { ctx, widgetCalls, statusCalls } = fakeCtx();
    await renderMeter(
      deps(
        meFetch({
          remaining_usd_today: 0,
          allowance_credits: 15_000,
          remaining_credits_today: 0,
          refill_at: "2026-10-15T00:00:00.000Z",
          lane: "fallback",
        }),
      ),
      ctx,
    );
    expect(statusCalls.at(-1)).toEqual({ key: METER_STATUS_KEY, text: "0 credits · slow lane" });
    expect(widgetCalls.at(-1)!.content).toEqual(["Out of free credits — slow lane until refill"]);
  });

  test("old server without credit fields and a notice both leave the footer status cleared", async () => {
    for (const body of [{ remaining_usd_today: 4.5 }, { remaining_usd_today: 0, notice: "buy more" }]) {
      const { ctx, statusCalls } = fakeCtx();
      await renderMeter(deps(meFetch(body)), ctx);
      expect(statusCalls.at(-1)).toEqual({ key: METER_STATUS_KEY, text: undefined });
    }
  });
});

describe("meter: low-credit and slow-lane nudges", () => {
  const BUY = "https://api.test/buy/SECRET.TOKEN.xyz";
  function me(remaining: number, extra: Record<string, unknown> = {}): typeof fetch {
    return (async () =>
      jsonResponse({
        user_id: "u1", handle: "o", cap_usd_today: 5, tier: "established", remaining_usd_today: 0.5,
        allowance_credits: 15_000, remaining_credits_today: remaining, refill_at: "2026-10-15T00:00:00.000Z",
        lane: "standard", buy_url: BUY, ...extra,
      })) as unknown as typeof fetch;
  }
  function colorCtx() {
    const r = fakeCtx();
    (r.ctx.ui as unknown as { theme: unknown }).theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => t };
    return r;
  }
  const link = (t: string) => `\x1b]8;;${BUY}\x07${t}\x1b]8;;\x07`;

  test("exactly 10% shows a warning-colored widget with a clickable link; footer unchanged", async () => {
    const { ctx, widgetCalls, statusCalls } = colorCtx();
    await renderMeter(deps(me(LOW_CREDIT_FRACTION * 15_000)), ctx);
    expect(widgetCalls.at(-1)!.content).toEqual([`<warning>Low on credits: 1,500 left today · Buy more: ${link("freepi.ai/buy")}</warning>`]);
    expect(statusCalls.at(-1)!.text).toBe("<muted>1,500 credits</muted>");
  });

  test("just above 10% and zero-remaining standard have no warning", async () => {
    const { ctx, widgetCalls } = colorCtx();
    await renderMeter(deps(me(1_501)), ctx);
    expect(widgetCalls.at(-1)!.content).toBeUndefined();
  });

  test("the raw buy_url is only the link target, never visible text", async () => {
    const { ctx, widgetCalls } = colorCtx();
    await renderMeter(deps(me(1_200)), ctx);
    const line = (widgetCalls.at(-1)!.content as string[])[0]!;
    const visible = line.replace(/\x1b\]8;;[^\x07]*\x07/g, "");
    expect(visible).not.toContain("SECRET");
    expect(visible).not.toContain("error");
  });

  test("a buy_url carrying control bytes cannot break out of the OSC 8 target", async () => {
    const { ctx, widgetCalls } = colorCtx();
    await renderMeter(deps(me(1_200, { buy_url: `${BUY}\x07\x1b[2J` })), ctx);
    const line = (widgetCalls.at(-1)!.content as string[])[0]!;
    expect(line).not.toContain("\x1b[2J");
    expect(line).toContain(link("freepi.ai/buy"));
  });

  test("no buy_url → warning without a link", async () => {
    const { ctx, widgetCalls } = colorCtx();
    await renderMeter(deps(me(1_200, { buy_url: undefined })), ctx);
    expect(widgetCalls.at(-1)!.content).toEqual(["<warning>Low on credits: 1,200 left today</warning>"]);
  });

  test("slow lane: footer plus warning widget with link", async () => {
    const { ctx, widgetCalls, statusCalls } = colorCtx();
    await renderMeter(deps(me(0, { lane: "fallback" })), ctx);
    expect(statusCalls.at(-1)!.text).toBe("<muted>0 credits · slow lane</muted>");
    expect(widgetCalls.at(-1)!.content).toEqual([`<warning>Out of free credits — slow lane until refill · Buy more: ${link("freepi.ai/buy")}</warning>`]);
  });
});

describe("meter: one-turn purchase confirmation when credit_usd rises", () => {
  function meAt(credit: number | undefined, remaining = 4.5): typeof fetch {
    return (async () => jsonResponse({ user_id: "u1", handle: "o", cap_usd_today: 5, tier: "established", remaining_usd_today: remaining, ...(credit === undefined ? {} : { credit_usd: credit }) })) as unknown as typeof fetch;
  }
  test("first poll sets the baseline silently; a rise shows the confirmation for CONFIRM_TURNS polls; then normal again", async () => {
    resetMeterState();
    const { ctx, widgetCalls } = fakeCtx();
    await renderMeter(deps(meAt(0)), ctx);
    expect(widgetCalls.at(-1)!.content).toBeUndefined();
    await renderMeter(deps(meAt(4)), ctx);
    expect(widgetCalls.at(-1)!.content).toEqual([creditAddedMessage(4)]);
    // Real $5-pack grant ($3.75) confirms as round credits, never the granted dollars.
    expect(creditAddedMessage(3.75)).toBe("Payment received — 50,000 credits added to your balance.");
    for (let i = 1; i < CONFIRM_TURNS; i++) {
      await renderMeter(deps(meAt(4)), ctx);
      expect(widgetCalls.at(-1)!.content).toEqual([creditAddedMessage(4)]);
    }
    await renderMeter(deps(meAt(4)), ctx);
    expect(widgetCalls.at(-1)!.content).toBeUndefined();
    // Spending credit (a fall) never triggers it.
    await renderMeter(deps(meAt(3.9)), ctx);
    expect(widgetCalls.at(-1)!.content).toBeUndefined();
  });
  test("an old server without credit_usd never triggers it", async () => {
    resetMeterState();
    const { ctx, widgetCalls } = fakeCtx();
    await renderMeter(deps(meAt(undefined)), ctx);
    await renderMeter(deps(meAt(undefined)), ctx);
    expect(widgetCalls.every((w) => w.content === undefined)).toBe(true);
  });
});
