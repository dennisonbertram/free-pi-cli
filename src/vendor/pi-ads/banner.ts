// R4/R6: persistent ad banner above the editor. Refreshed on session start,
// on turn_end (at most once a minute), and every 10 minutes while idle
// (index.ts owns the cadence). Empty slot (204) or a
// fetch failure both clear the widget outright — never a stale or half-drawn
// frame, never anything that blocks the chat turn.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { fetchAdNext, fireGravityImpression, postImpression } from "./api";
import type { AdScreen } from "./screen";
import { adWidget } from "./style";

export const BANNER_WIDGET_ID = "freepi-ad";

export interface BannerRendererOptions {
  /** KTD7: mirrors the currently-shown banner's click URL out to /support.
   * Called with the ad's click_url after a successful fetch, and with
   * `undefined` when no ad is shown (204 or fetch failure). */
  onBannerAd?: (clickUrl: string | undefined) => void;
  /** Checked after the fetch resolves: false (session shut down) skips every side effect. */
  isActive?: () => boolean;
  /** Shared with the inline renderer so no own ad is ever visible beside a Gravity ad. */
  screen?: AdScreen;
}

export interface BannerRenderer {
  /** Fetch + show the banner slot. The widget lays itself out at the width pi renders it at. */
  render(deps: AdsDeps, ctx: ExtensionContext, config: Config): Promise<void>;
}

/**
 * Per-extension-instance renderer. Tracks the last click_token an impression
 * was posted for so a re-render of the *same* fetched ad (a repaint, not a
 * new /ads/next call) never double-posts — each /ads/next call always mints
 * a fresh click_token server-side, so this dedup only ever suppresses actual
 * repaints, never distinct impressions.
 */
export function createBannerRenderer(opts: BannerRendererOptions = {}): BannerRenderer {
  let lastPostedToken: string | undefined;
  const screen = opts.screen ?? {};

  return {
    async render(deps, ctx, config) {
      const ad = await fetchAdNext(deps, "banner");
      if (opts.isActive && !opts.isActive()) return;
      if (!ad) {
        screen.banner = undefined;
        ctx.ui.setWidget(BANNER_WIDGET_ID, undefined);
        opts.onBannerAd?.(undefined);
        return;
      }

      // Gravity's rule: no other ad (of any source) on screen beside a Gravity ad.
      // A banner yields to a visible Gravity inline card; a Gravity banner clears any inline card.
      const isGravity = ad.source === "gravity";
      if (screen.inline === "gravity") {
        screen.banner = undefined;
        ctx.ui.setWidget(BANNER_WIDGET_ID, undefined);
        opts.onBannerAd?.(undefined);
        return;
      }
      if (isGravity && screen.inline) screen.clearInline?.();
      screen.banner = isGravity ? "gravity" : "own";
      screen.clearBanner = () => {
        screen.banner = undefined;
        ctx.ui.setWidget(BANNER_WIDGET_ID, undefined);
        opts.onBannerAd?.(undefined);
      };

      ctx.ui.setWidget(BANNER_WIDGET_ID, adWidget(ad.creative, ad.click_url, config.adMinColumns));
      opts.onBannerAd?.(ad.click_url);

      if (lastPostedToken !== ad.click_token) {
        lastPostedToken = ad.click_token;
        const impFired = fireGravityImpression(deps, ad);
        await postImpression(deps, ad.ad_id, ad.click_token, impFired);
      }
    },
  };
}
