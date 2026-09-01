// pi extension entry point (U7). KTD9 / R5: this extension registers only
// lifecycle/UI hooks (session_start, turn_end, session_shutdown) — never
// context, before_provider_request, before_agent_start, message_*, tool_*,
// or agent_*. See src/sandbox.test.ts for the enforced proof. Ad content
// only ever reaches the terminal through ctx.ui.setWidget; it never touches
// pi.sendMessage / pi.sendUserMessage / pi.appendEntry / the session.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { createBannerRenderer } from "./banner";
import { createInlineRenderer } from "./inline";
import { renderMeter } from "./meter";

/** Minimal emitter surface for terminal resize events; production is process.stdout. */
export interface ResizeSource {
  on(event: "resize", listener: () => void): unknown;
  off(event: "resize", listener: () => void): unknown;
}

export interface CreateAdsExtensionOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  sessionId: string;
  fetchImpl?: typeof fetch;
  /** KTD7: mirrors the currently-shown banner ad's click URL to the caller
   * (free-pi-cli's /support command) — undefined when no ad is shown. */
  onBannerAd?: (clickUrl: string | undefined) => void;
  /** Testing seam for terminal resize events; defaults to process.stdout. */
  resizeSource?: ResizeSource;
}

const BANNER_REFRESH_MS = 10 * 60 * 1000;
// Terminal drags emit a burst of resize events; repaint once, after the burst.
const RESIZE_DEBOUNCE_MS = 150;

/** Init function the cli calls with baseUrl + a token getter, decoupled from any credential-store detail. */
export function createAdsExtension(opts: CreateAdsExtensionOptions): InlineExtension {
  const deps: AdsDeps = {
    baseUrl: opts.baseUrl,
    getToken: opts.getToken,
    sessionId: opts.sessionId,
    fetchImpl: opts.fetchImpl,
  };
  const config = loadConfig();

  return {
    name: "free-pi-ads",
    factory(pi: ExtensionAPI) {
      const banner = createBannerRenderer({ onBannerAd: opts.onBannerAd });
      const inline = createInlineRenderer();
      // Timers and listeners are session-scoped resources: started in
      // session_start, torn down in session_shutdown, per pi's own extension
      // guidance (never started from the factory itself).
      let bannerInterval: ReturnType<typeof setInterval> | undefined;
      let resizeListener: (() => void) | undefined;
      let resizeDebounce: ReturnType<typeof setTimeout> | undefined;
      const resizeSource = opts.resizeSource ?? (process.stdout as ResizeSource);

      pi.on("session_start", async (_event, ctx) => {
        inline.reset(ctx);

        await Promise.all([banner.render(deps, ctx, config), renderMeter(deps, ctx)]);

        if (bannerInterval) clearInterval(bannerInterval);
        bannerInterval = setInterval(() => {
          void banner.render(deps, ctx, config);
        }, BANNER_REFRESH_MS);
        (bannerInterval as unknown as { unref?: () => void }).unref?.();

        // Repaint (never re-fetch) the banner when the terminal is resized:
        // banner.redraw re-lays-out the CACHED ad at the new width. Routing
        // this through render() instead would call /ads/next, whose fresh
        // click_token posts a new impression — a window drag must not
        // inflate impression counts (see banner.ts). UI-only by
        // construction: same ctx.ui.setWidget surface as every other paint,
        // no pi hook involved, so the sandbox surface is unchanged.
        if (resizeListener) resizeSource.off("resize", resizeListener);
        resizeListener = () => {
          if (resizeDebounce) clearTimeout(resizeDebounce);
          resizeDebounce = setTimeout(() => banner.redraw(ctx, config), RESIZE_DEBOUNCE_MS);
          (resizeDebounce as unknown as { unref?: () => void }).unref?.();
        };
        resizeSource.on("resize", resizeListener);
      });

      pi.on("turn_end", async (_event, ctx) => {
        await Promise.all([inline.onTurnEnd(deps, ctx, config), renderMeter(deps, ctx)]);
      });

      pi.on("session_shutdown", () => {
        if (bannerInterval) {
          clearInterval(bannerInterval);
          bannerInterval = undefined;
        }
        if (resizeListener) {
          resizeSource.off("resize", resizeListener);
          resizeListener = undefined;
        }
        if (resizeDebounce) {
          clearTimeout(resizeDebounce);
          resizeDebounce = undefined;
        }
      });
    },
  };
}
