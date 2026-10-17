// Resize handling: the banner repaints at the new width from its CACHED ad —
// never via /ads/next, whose fresh click_token would post a new impression on
// every window drag. Structural sandbox guarantees are unchanged (the resize
// listener is a Node event on process.stdout, not a pi hook — sandbox.test.ts
// still asserts the exact three-hook surface).
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigSchema } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { BANNER_WIDGET_ID, createBannerRenderer } from "./banner";
import { createAdsExtension, type ResizeSource } from "./index";

const config = ConfigSchema.parse({}); // defaults: adMinColumns 60

interface WidgetCall {
  id: string;
  content: unknown;
}

function fakeCtx(): { ctx: ExtensionContext; widgetCalls: WidgetCall[] } {
  const widgetCalls: WidgetCall[] = [];
  const ui = {
    setWidget: (id: string, content: unknown) => {
      widgetCalls.push({ id, content });
    },
    theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
  };
  return { ctx: { ui } as unknown as ExtensionContext, widgetCalls };
}

/** Counts /ads/next and /ads/impression hits; serves one fixed ad. */
function countingFetch(): { fetchImpl: typeof fetch; counts: { next: number; impression: number } } {
  const counts = { next: 0, impression: 0 };
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(input.toString());
    if (url.pathname === "/ads/next") {
      counts.next += 1;
      return Response.json({
        ad_id: "ad-1",
        click_token: `tok-${counts.next}`,
        creative: { headline: "Ship faster", body: "with acme", cta: "Try it", accent: "#f0f" },
        click_url: "https://freepi.ai/c/1",
      });
    }
    if (url.pathname === "/ads/impression") {
      counts.impression += 1;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/me") {
      return Response.json({ user_id: "u1", handle: "octocat", remaining_usd_today: 4.5 });
    }
    return new Response(null, { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, counts };
}

function deps(fetchImpl: typeof fetch): AdsDeps {
  return { baseUrl: "http://stub.local", getToken: () => "jwt", sessionId: "sess-1", fetchImpl };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("banner.redraw — cached repaint, zero network", () => {
  test("re-lays-out the same ad at the new width with NO second /ads/next and NO second impression", async () => {
    const { fetchImpl, counts } = countingFetch();
    const { ctx, widgetCalls } = fakeCtx();
    const banner = createBannerRenderer();

    await banner.render(deps(fetchImpl), ctx, config, 100);
    expect(counts).toEqual({ next: 1, impression: 1 });
    expect(widgetCalls.length).toBe(1);

    banner.redraw(ctx, config, 120);
    expect(counts).toEqual({ next: 1, impression: 1 });
    expect(widgetCalls.length).toBe(2);
    expect(widgetCalls[1]?.id).toBe(BANNER_WIDGET_ID);
    expect(widgetCalls[1]?.content).not.toEqual(widgetCalls[0]?.content);
  });

  test("crossing adMinColumns flips card <-> plain line, both directions", async () => {
    const { fetchImpl } = countingFetch();
    const { ctx, widgetCalls } = fakeCtx();
    const banner = createBannerRenderer();

    await banner.render(deps(fetchImpl), ctx, config, 100); // wide -> multi-line card
    banner.redraw(ctx, config, 40); // narrow -> single plain line
    banner.redraw(ctx, config, 100); // wide again -> card again

    const lineCounts = widgetCalls.map((w) => (w.content as string[]).length);
    expect(lineCounts[0]).toBeGreaterThan(1);
    expect(lineCounts[1]).toBe(1);
    expect(lineCounts[2]).toBe(lineCounts[0]);
  });

  test("redraw before any render is a no-op; redraw after an empty slot (204) stays cleared", async () => {
    const empty204 = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const { ctx, widgetCalls } = fakeCtx();
    const banner = createBannerRenderer();

    banner.redraw(ctx, config, 80); // nothing fetched yet
    expect(widgetCalls.length).toBe(0);

    await banner.render(deps(empty204), ctx, config, 80); // empty slot clears the widget
    expect(widgetCalls.length).toBe(1);
    expect(widgetCalls[0]?.content).toBeUndefined();

    banner.redraw(ctx, config, 80); // nothing cached -> nothing repainted
    expect(widgetCalls.length).toBe(1);
  });
});

describe("extension wiring — session-scoped, debounced resize listener", () => {
  type Handler = (event: unknown, ctx: unknown) => unknown;

  function createFakePi(): { pi: ExtensionAPI; handlers: Map<string, Handler[]> } {
    const handlers = new Map<string, Handler[]>();
    const pi = new Proxy(
      {},
      {
        get(_target, prop: string) {
          if (prop === "on") {
            return (event: string, handler: Handler) => {
              const list = handlers.get(event) ?? [];
              list.push(handler);
              handlers.set(event, list);
            };
          }
          return () => undefined;
        },
      },
    ) as unknown as ExtensionAPI;
    return { pi, handlers };
  }

  function fakeResizeSource(): ResizeSource & { emit: () => void; listenerCount: () => number } {
    const listeners = new Set<() => void>();
    return {
      on: (_e, l) => listeners.add(l),
      off: (_e, l) => listeners.delete(l),
      emit: () => {
        for (const l of listeners) l();
      },
      listenerCount: () => listeners.size,
    };
  }

  test("a burst of resize events repaints once (debounced), from cache; shutdown removes the listener", async () => {
    const { fetchImpl, counts } = countingFetch();
    const resizeSource = fakeResizeSource();
    const { pi, handlers } = createFakePi();
    const { ctx, widgetCalls } = fakeCtx();

    // Same cast sandbox.test.ts uses: InlineExtension is a union, and this
    // extension is the object form with a factory.
    const ext = createAdsExtension({
      baseUrl: "http://stub.local",
      getToken: () => "jwt",
      sessionId: "sess-1",
      fetchImpl,
      resizeSource,
    }) as { name: string; factory: (pi: ExtensionAPI) => void };
    ext.factory(pi);

    await handlers.get("session_start")![0]!({}, ctx);
    expect(resizeSource.listenerCount()).toBe(1);
    const paintsAfterStart = widgetCalls.filter((w) => w.id === BANNER_WIDGET_ID).length;
    expect(counts.next).toBe(1);

    // A drag: many events, one repaint after the debounce window.
    resizeSource.emit();
    resizeSource.emit();
    resizeSource.emit();
    await sleep(250);
    const paintsAfterBurst = widgetCalls.filter((w) => w.id === BANNER_WIDGET_ID).length;
    expect(paintsAfterBurst).toBe(paintsAfterStart + 1);
    // Still exactly one fetch and one impression: resize repaints from cache.
    expect(counts).toEqual({ next: 1, impression: 1 });

    // Shutdown: listener gone, further resizes are inert.
    handlers.get("session_shutdown")![0]!({}, ctx);
    expect(resizeSource.listenerCount()).toBe(0);
    resizeSource.emit();
    await sleep(250);
    expect(widgetCalls.filter((w) => w.id === BANNER_WIDGET_ID).length).toBe(paintsAfterBurst);
  });
});
