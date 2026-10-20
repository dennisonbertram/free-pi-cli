// Gravity SDK integration: context header, client-fired impression, and the
// "no other ad beside a Gravity ad" rule across banner and inline widgets.
import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { createBannerRenderer } from "./banner";
import { createInlineRenderer } from "./inline";
import type { AdScreen } from "./screen";

const config = loadConfig({});
const IMP = "https://api.trygravity.ai/imp?x=1";

type Ad = { source?: string; imp_url?: string };
let n = 0;
function ad(extra: Ad = {}) {
  return {
    ad_id: "ad-1",
    click_token: `tok-${++n}`,
    creative: { headline: "Try it", body: "The best", cta: "Go", accent: "#ff00ff" },
    click_url: "https://api.test/c/x",
    ...extra,
  };
}

function ctx() {
  const widgets = new Map<string, unknown>();
  const c = {
    ui: {
      setWidget: (id: string, v: unknown) => (v === undefined ? widgets.delete(id) : widgets.set(id, v)),
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
    },
  } as unknown as ExtensionContext;
  return { c, widgets };
}

/** Fake network: /ads/next serves `ads[slot]`; records every call. */
function net(ads: Partial<Record<"banner" | "inline", ReturnType<typeof ad>>>, impStatus: number | "throw" = 200) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body as string | undefined });
    if (url.includes("/ads/next")) {
      const a = ads[url.includes("slot=inline") ? "inline" : "banner"];
      return a ? Response.json(a) : new Response(null, { status: 204 });
    }
    if (url.startsWith("https://api.trygravity")) {
      if (impStatus === "throw") throw new Error("net");
      return new Response(null, { status: impStatus });
    }
    return Response.json({});
  }) as unknown as typeof fetch;
  const deps = (extra: Partial<AdsDeps> = {}): AdsDeps => ({ baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl, ...extra });
  const impressionBodies = () => calls.filter((c) => c.url.endsWith("/ads/impression")).map((c) => JSON.parse(c.body!));
  const impFetches = () => calls.filter((c) => c.url.startsWith("https://api.trygravity"));
  return { calls, deps, impressionBodies, impFetches };
}

describe("x-gravity-context header", () => {
  test("sent on /ads/next when the getter returns a value", async () => {
    const t = net({ banner: ad() });
    await createBannerRenderer().render(t.deps({ getGravityContext: () => "abc" }), ctx().c, config);
    expect(t.calls.find((c) => c.url.includes("/ads/next"))!.headers["x-gravity-context"]).toBe("abc");
  });

  test("not sent when the getter returns undefined, throws, or is absent; never on /ads/impression", async () => {
    for (const getGravityContext of [() => undefined, () => { throw new Error("x"); }, undefined]) {
      const t = net({ banner: ad() });
      await createBannerRenderer().render(t.deps({ getGravityContext }), ctx().c, config);
      expect(t.calls.some((c) => "x-gravity-context" in c.headers)).toBe(false);
    }
    const t = net({ banner: ad() });
    await createBannerRenderer().render(t.deps({ getGravityContext: () => "abc" }), ctx().c, config);
    expect("x-gravity-context" in t.calls.find((c) => c.url.endsWith("/ads/impression"))!.headers).toBe(false);
  });
});

describe("client-fired Gravity impression", () => {
  test("gravity banner: imp_url fired once with no auth header, imp_fired true posted", async () => {
    const t = net({ banner: ad({ source: "gravity", imp_url: IMP }) });
    await createBannerRenderer().render(t.deps(), ctx().c, config);
    expect(t.impFetches().map((c) => c.url)).toEqual([IMP]);
    expect(t.impFetches()[0]!.headers.Authorization).toBeUndefined();
    expect(t.impressionBodies()[0].imp_fired).toBe(true);
  });

  test("gravity inline ad fires too", async () => {
    const t = net({ inline: ad({ source: "gravity", imp_url: IMP }) });
    const inline = createInlineRenderer();
    for (let i = 0; i < config.adInlineTurnFrequency; i++) await inline.onTurnEnd(t.deps(), ctx().c, config);
    expect(t.impFetches().length).toBe(1);
    expect(t.impressionBodies()[0].imp_fired).toBe(true);
  });

  test("own ad, or a non-Gravity host, is never fired", async () => {
    for (const a of [ad({ source: "own", imp_url: IMP }), ad({ source: "gravity", imp_url: "https://evil.example/imp" }), ad({ source: "gravity", imp_url: "http://api.trygravity.ai/imp" }), ad({ source: "gravity", imp_url: "https://nottrygravity.ai/imp" })]) {
      const t = net({ banner: a });
      await createBannerRenderer().render(t.deps(), ctx().c, config);
      expect(t.impFetches().length).toBe(0);
      expect(t.calls.filter((c) => c.url.includes("evil") || c.url.includes("nottry")).length).toBe(0);
      expect(t.impressionBodies()[0].imp_fired).toBeUndefined();
    }
  });

  test("an attempted fire that fails still sends imp_fired true (no double count)", async () => {
    for (const status of ["throw", 500] as const) {
      const t = net({ banner: ad({ source: "gravity", imp_url: IMP }) }, status);
      await createBannerRenderer().render(t.deps(), ctx().c, config);
      expect(t.impFetches().length).toBe(1);
      expect(t.impressionBodies()[0].imp_fired).toBe(true);
    }
  });

  test("a synchronously throwing fetch is still an attempt", async () => {
    const t = net({ banner: ad({ source: "gravity", imp_url: IMP }) });
    const inner = t.deps().fetchImpl!;
    const fetchImpl = ((url: string, init?: RequestInit) => {
      if (url.startsWith("https://api.trygravity")) throw new Error("sync");
      return inner(url, init);
    }) as unknown as typeof fetch;
    await createBannerRenderer().render(t.deps({ fetchImpl }), ctx().c, config);
    expect(t.impressionBodies()[0].imp_fired).toBe(true);
  });

  test("render and /ads/impression do not wait for a pending pixel GET", async () => {
    const t = net({ banner: ad({ source: "gravity", imp_url: IMP }), inline: ad({ source: "gravity", imp_url: IMP }) });
    const inner = t.deps().fetchImpl!;
    const fetchImpl = ((url: string, init?: RequestInit) =>
      url.startsWith("https://api.trygravity") ? new Promise(() => {}) : inner(url, init)) as unknown as typeof fetch;
    const done = await Promise.race([
      createBannerRenderer().render(t.deps({ fetchImpl }), ctx().c, config).then(() => "done"),
      new Promise((r) => setTimeout(() => r("hung"), 500)),
    ]);
    expect(done).toBe("done");
    expect(t.impressionBodies()[0].imp_fired).toBe(true);
    const inl = createInlineRenderer();
    const done2 = await Promise.race([
      (async () => { for (let i = 0; i < config.adInlineTurnFrequency; i++) await inl.onTurnEnd(t.deps({ fetchImpl }), ctx().c, config); return "done"; })(),
      new Promise((r) => setTimeout(() => r("hung"), 500)),
    ]);
    expect(done2).toBe("done");
  });
});

describe("no other ad beside a Gravity ad", () => {
  const freq = config.adInlineTurnFrequency;
  const turns = async (inline: ReturnType<typeof createInlineRenderer>, t: ReturnType<typeof net>, c: ExtensionContext) => {
    for (let i = 0; i < freq; i++) await inline.onTurnEnd(t.deps(), c, config);
  };

  test("own inline is skipped (no fetch) while a Gravity banner is shown", async () => {
    const screen: AdScreen = {};
    const t = net({ banner: ad({ source: "gravity", imp_url: IMP }), inline: ad({ source: "own" }) });
    const { c, widgets } = ctx();
    await createBannerRenderer({ screen }).render(t.deps(), c, config);
    await turns(createInlineRenderer(screen), t, c);
    expect(t.calls.some((x) => x.url.includes("slot=inline"))).toBe(false);
    expect([...widgets.keys()]).toEqual(["freepi-ad"]);
  });

  test("own banner is cleared when a Gravity inline ad shows, and stays hidden until inline clears", async () => {
    const screen: AdScreen = {};
    const t = net({ banner: ad({ source: "own" }), inline: ad({ source: "gravity", imp_url: IMP }) });
    const { c, widgets } = ctx();
    const clicks: Array<string | undefined> = [];
    const banner = createBannerRenderer({ screen, onBannerAd: (u) => clicks.push(u) });
    const inline = createInlineRenderer(screen);
    await banner.render(t.deps(), c, config);
    expect(widgets.has("freepi-ad")).toBe(true);
    await turns(inline, t, c);
    expect([...widgets.keys()]).toEqual(["freepi-ad-inline"]);
    expect(clicks.at(-1)).toBeUndefined();
    // A banner refresh while the Gravity inline card is visible must not bring the own banner back.
    await banner.render(t.deps(), c, config);
    expect([...widgets.keys()]).toEqual(["freepi-ad-inline"]);
    // Next turn clears the inline card; the next refresh restores the banner.
    await inline.onTurnEnd(t.deps(), c, config);
    await banner.render(t.deps(), c, config);
    expect([...widgets.keys()]).toEqual(["freepi-ad"]);
  });

  test("a Gravity banner clears a visible own inline card", async () => {
    const screen: AdScreen = {};
    const t = net({ banner: ad({ source: "gravity", imp_url: IMP }), inline: ad({ source: "own" }) });
    const { c, widgets } = ctx();
    const inline = createInlineRenderer(screen);
    await turns(inline, t, c);
    expect(widgets.has("freepi-ad-inline")).toBe(true);
    await createBannerRenderer({ screen }).render(t.deps(), c, config);
    expect([...widgets.keys()]).toEqual(["freepi-ad"]);
  });

  test("Gravity banner showing: no Gravity inline is fetched or shown", async () => {
    const screen: AdScreen = {};
    const t = net({ banner: ad({ source: "gravity", imp_url: IMP }), inline: ad({ source: "gravity", imp_url: IMP }) });
    const { c, widgets } = ctx();
    await createBannerRenderer({ screen }).render(t.deps(), c, config);
    await turns(createInlineRenderer(screen), t, c);
    expect(t.calls.some((x) => x.url.includes("slot=inline"))).toBe(false);
    expect([...widgets.keys()]).toEqual(["freepi-ad"]);
  });

  test("Gravity inline showing: a Gravity banner refresh is hidden", async () => {
    const screen: AdScreen = {};
    const t = net({ banner: ad({ source: "gravity", imp_url: IMP }), inline: ad({ source: "gravity", imp_url: IMP }) });
    const { c, widgets } = ctx();
    await turns(createInlineRenderer(screen), t, c);
    await createBannerRenderer({ screen }).render(t.deps(), c, config);
    expect([...widgets.keys()]).toEqual(["freepi-ad-inline"]);
  });

  test("in-flight Gravity inline arriving after a Gravity banner appeared is dropped", async () => {
    const screen: AdScreen = {};
    const t = net({ banner: ad({ source: "gravity", imp_url: IMP }), inline: ad({ source: "gravity", imp_url: IMP }) });
    const { c, widgets } = ctx();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = t.deps().fetchImpl!;
    const slowInline = ((url: string, init?: RequestInit) =>
      url.includes("slot=inline") ? gate.then(() => inner(url, init)) : inner(url, init)) as unknown as typeof fetch;
    const inline = createInlineRenderer(screen);
    const pending = (async () => { for (let i = 0; i < config.adInlineTurnFrequency; i++) await inline.onTurnEnd(t.deps({ fetchImpl: slowInline }), c, config); })();
    await new Promise((r) => setTimeout(r, 10));
    await createBannerRenderer({ screen }).render(t.deps(), c, config);
    release();
    await pending;
    expect([...widgets.keys()]).toEqual(["freepi-ad"]);
  });

  test("in-flight Gravity banner arriving after a Gravity inline appeared is hidden", async () => {
    const screen: AdScreen = {};
    const t = net({ banner: ad({ source: "gravity", imp_url: IMP }), inline: ad({ source: "gravity", imp_url: IMP }) });
    const { c, widgets } = ctx();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = t.deps().fetchImpl!;
    const slowBanner = ((url: string, init?: RequestInit) =>
      url.includes("slot=banner") ? gate.then(() => inner(url, init)) : inner(url, init)) as unknown as typeof fetch;
    const pending = createBannerRenderer({ screen }).render(t.deps({ fetchImpl: slowBanner }), c, config);
    await turns(createInlineRenderer(screen), t, c);
    release();
    await pending;
    expect([...widgets.keys()]).toEqual(["freepi-ad-inline"]);
  });

  test("own banner beside own inline is unchanged", async () => {
    const screen: AdScreen = {};
    const t = net({ banner: ad({ source: "own" }), inline: ad({ source: "own" }) });
    const { c, widgets } = ctx();
    await createBannerRenderer({ screen }).render(t.deps(), c, config);
    await turns(createInlineRenderer(screen), t, c);
    expect([...widgets.keys()].sort()).toEqual(["freepi-ad", "freepi-ad-inline"]);
  });
});
