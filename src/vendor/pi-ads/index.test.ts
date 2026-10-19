// Banner refresh cadence: session_start renders once, then every trigger
// (turn_end, idle interval) shares one throttle of 60s since the last render
// finished, with no overlapping renders and no side effects after shutdown.
import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAdsExtension } from "./index";

type Handler = (event: unknown, ctx: unknown) => unknown;
const realNow = Date.now;
const realSetInterval = globalThis.setInterval;
const realSetTimeout = globalThis.setTimeout;
afterEach(() => {
  Date.now = realNow;
  globalThis.setInterval = realSetInterval;
});

function adResponse() {
  return Response.json({
    ad_id: "ad-1",
    click_token: `tok-${Math.random()}`,
    creative: { headline: "Try it", body: "The best", cta: "Learn more", accent: "#ff00ff" },
    click_url: "https://api.test/c/1",
  });
}

/** `bannerGate`, when it returns a promise, holds that banner fetch until it resolves. */
async function setup(bannerGate?: () => Promise<void> | undefined) {
  const handlers = new Map<string, Handler>();
  const pi = { on: (e: string, h: Handler) => handlers.set(e, h) } as unknown as ExtensionAPI;
  let widgetWrites = 0;
  const ctx = {
    ui: {
      setStatus: () => {},
      setWidget: (id: string) => {
        if (id === "freepi-ad") widgetWrites++;
      },
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
  let bannerFetches = 0;
  let impressions = 0;
  const fetchImpl = (async (input: string) => {
    const url = new URL(input.toString());
    if (url.pathname === "/ads/next" && url.searchParams.get("slot") === "banner") {
      bannerFetches++;
      await bannerGate?.();
      return adResponse();
    }
    if (url.pathname === "/ads/impression") impressions++;
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  let tick: (() => void) | undefined;
  globalThis.setInterval = ((fn: () => void) => {
    tick = fn;
    return 0;
  }) as unknown as typeof setInterval;
  const ext = createAdsExtension({ baseUrl: "https://api.test", getToken: () => "jwt", sessionId: "s", fetchImpl }) as {
    factory: (pi: ExtensionAPI) => void;
  };
  ext.factory(pi);
  let now = 1_000_000;
  Date.now = () => now;
  await handlers.get("session_start")!({}, ctx);
  const flush = () => new Promise((r) => realSetTimeout(r, 5));
  return {
    banners: () => bannerFetches,
    impressions: () => impressions,
    widgetWrites: () => widgetWrites,
    flush,
    interval: async (advanceMs: number) => {
      now += advanceMs;
      tick!();
      await flush();
    },
    // turn_end does not wait for the banner fetch, so flush before callers count requests.
    turnEnd: async (advanceMs: number) => {
      now += advanceMs;
      await handlers.get("turn_end")!({}, ctx);
      await flush();
    },
    rawTurnEnd: () => handlers.get("turn_end")!({}, ctx) as Promise<void>,
    advance: (ms: number) => {
      now += ms;
    },
    shutdown: () => handlers.get("session_shutdown")!({}, ctx),
  };
}

describe("banner refresh on turn_end", () => {
  test("turn_end at 59s does not refetch the banner", async () => {
    const t = await setup();
    expect(t.banners()).toBe(1);
    await t.turnEnd(30_000);
    await t.turnEnd(29_000);
    expect(t.banners()).toBe(1);
    t.shutdown();
  });

  test("turn_end after 60s refetches once; a second turn_end 10s later does not", async () => {
    const t = await setup();
    await t.turnEnd(60_000);
    expect(t.banners()).toBe(2);
    await t.turnEnd(10_000);
    expect(t.banners()).toBe(2);
    await t.turnEnd(50_000);
    expect(t.banners()).toBe(3);
    t.shutdown();
  });

  test("the idle interval respects the 60s throttle after a turn render", async () => {
    const t = await setup();
    await t.turnEnd(60_000);
    expect(t.banners()).toBe(2);
    await t.interval(1_000);
    expect(t.banners()).toBe(2);
    await t.interval(60_000);
    expect(t.banners()).toBe(3);
    t.shutdown();
  });

  test("turn_end while a banner render is pending does not start a second request", async () => {
    let release!: () => void;
    let gate: Promise<void> | undefined;
    const t = await setup(() => gate);
    gate = new Promise<void>((r) => (release = r));
    const first = t.turnEnd(60_000);
    await t.flush();
    expect(t.banners()).toBe(2);
    await t.turnEnd(120_000);
    expect(t.banners()).toBe(2);
    release();
    await first;
    t.shutdown();
  });

  test("a render resolving after session_shutdown writes no widget and posts no impression", async () => {
    let release!: () => void;
    let gate: Promise<void> | undefined;
    const t = await setup(() => gate);
    const writes = t.widgetWrites();
    const impressions = t.impressions();
    gate = new Promise<void>((r) => (release = r));
    const pending = t.turnEnd(60_000);
    await t.flush();
    t.shutdown();
    release();
    await pending;
    await t.flush();
    expect(t.widgetWrites()).toBe(writes);
    expect(t.impressions()).toBe(impressions);
  });

  test("turn_end resolves before a slow banner fetch completes", async () => {
    let release!: () => void;
    let gate: Promise<void> | undefined;
    const t = await setup(() => gate);
    gate = new Promise<void>((r) => (release = r));
    t.advance(60_000);
    let resolved = false;
    await t.rawTurnEnd().then(() => (resolved = true));
    expect(resolved).toBe(true);
    expect(t.banners()).toBe(2);
    expect(t.impressions()).toBe(1);
    release();
    await t.flush();
    expect(t.impressions()).toBe(2);
    t.shutdown();
  });
});
