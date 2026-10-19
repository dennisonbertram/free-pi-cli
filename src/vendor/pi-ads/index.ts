// pi extension entry point (U7). KTD9 / R5: this extension registers only
// lifecycle/UI hooks (session_start, turn_end, session_shutdown) — never
// context, before_provider_request, before_agent_start, message_*, tool_*,
// or agent_*. See src/sandbox.test.ts for the enforced proof. Ad content
// only ever reaches the terminal through ctx.ui.setWidget; it never touches
// pi.sendMessage / pi.sendUserMessage / pi.appendEntry / the session.
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { createBannerRenderer } from "./banner";
import { createInlineRenderer } from "./inline";
import type { AdScreen } from "./screen";
import { renderMeter } from "./meter";

export interface CreateAdsExtensionOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  sessionId: string;
  fetchImpl?: typeof fetch;
  /** Base64url Gravity context for the /ads/next header; undefined result = header omitted. */
  getGravityContext?: () => string | undefined;
  /** KTD7: mirrors the currently-shown banner ad's click URL to the caller
   * (free-pi-cli's /support command) — undefined when no ad is shown. */
  onBannerAd?: (clickUrl: string | undefined) => void;
}

// Idle fallback refresh, plus a per-step refresh on turn_end capped at one
// banner render per BANNER_MIN_REFRESH_MS (measured from the last render).
const BANNER_REFRESH_MS = 10 * 60 * 1000;
const BANNER_MIN_REFRESH_MS = 60 * 1000;

/** Init function the cli calls with baseUrl + a token getter, decoupled from any credential-store detail. */
export function createAdsExtension(opts: CreateAdsExtensionOptions): InlineExtension {
  const deps: AdsDeps = {
    baseUrl: opts.baseUrl,
    getToken: opts.getToken,
    sessionId: opts.sessionId,
    fetchImpl: opts.fetchImpl,
    getGravityContext: opts.getGravityContext,
  };
  const config = loadConfig();

  return {
    name: "free-pi-ads",
    factory(pi: ExtensionAPI) {
      let stopped = false;
      const screen: AdScreen = {};
      const banner = createBannerRenderer({ onBannerAd: opts.onBannerAd, isActive: () => !stopped, screen });
      const inline = createInlineRenderer(screen);
      // Timers are session-scoped resources: started in session_start, torn
      // down in session_shutdown, per pi's own extension guidance (never
      // started from the factory itself).
      let bannerInterval: ReturnType<typeof setInterval> | undefined;
      let lastBannerAt = 0;
      let bannerInFlight = false;
      // Every trigger shares one throttle: skip while a render is pending or
      // the last one finished under BANNER_MIN_REFRESH_MS ago. session_start
      // forces a render.
      const renderBanner = async (ctx: ExtensionContext, force = false) => {
        if (stopped) return;
        if (!force && (bannerInFlight || Date.now() - lastBannerAt < BANNER_MIN_REFRESH_MS)) return;
        bannerInFlight = true;
        try {
          await banner.render(deps, ctx, config);
        } finally {
          bannerInFlight = false;
          lastBannerAt = Date.now();
        }
      };

      pi.on("session_start", async (_event, ctx) => {
        stopped = false;
        inline.reset(ctx);

        await Promise.all([renderBanner(ctx, true), renderMeter(deps, ctx)]);

        if (bannerInterval) clearInterval(bannerInterval);
        bannerInterval = setInterval(() => {
          void renderBanner(ctx);
        }, BANNER_REFRESH_MS);
        (bannerInterval as unknown as { unref?: () => void }).unref?.();
      });

      pi.on("turn_end", async (_event, ctx) => {
        // Not awaited: a slow /ads/next (Gravity can take seconds) must not
        // hold up the agent's next step.
        void renderBanner(ctx);
        await Promise.all([inline.onTurnEnd(deps, ctx, config), renderMeter(deps, ctx)]);
      });

      pi.on("session_shutdown", () => {
        stopped = true;
        if (bannerInterval) {
          clearInterval(bannerInterval);
          bannerInterval = undefined;
        }
      });
    },
  };
}
