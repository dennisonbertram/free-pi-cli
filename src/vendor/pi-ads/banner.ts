// R4/R6: persistent ad banner above the editor. Refreshed on session start
// and every 10 minutes (index.ts owns the interval). Empty slot (204) or a
// fetch failure both clear the widget outright — never a stale or half-drawn
// frame, never anything that blocks the chat turn.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdNextResponse, Config } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { fetchAdNext, postImpression } from "./api";
import { renderAdCard, renderPlainAdLine, type ThemeLike } from "./style";

export const BANNER_WIDGET_ID = "freepi-ad";

export interface BannerRendererOptions {
  /** KTD7: mirrors the currently-shown banner's click URL out to /support.
   * Called with the ad's click_url after a successful fetch, and with
   * `undefined` when no ad is shown (204 or fetch failure). */
  onBannerAd?: (clickUrl: string | undefined) => void;
}

export interface BannerRenderer {
  /** Fetch + render the banner slot. `columnsOverride` is a testing seam; production reads the real terminal width. */
  render(deps: AdsDeps, ctx: ExtensionContext, config: Config, columnsOverride?: number): Promise<void>;
  /**
   * Repaint the last fetched ad at the current width — no fetch, no
   * impression. This is the resize path: render() would call /ads/next,
   * which mints a fresh click_token and therefore posts a NEW impression —
   * dragging a terminal edge must not inflate impression counts. No-op
   * until render() has run (nothing to repaint) and when the slot was
   * empty (the widget is already cleared).
   */
  redraw(ctx: ExtensionContext, config: Config, columnsOverride?: number): void;
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
  let lastAd: AdNextResponse | undefined;

  /** Width-aware layout + widget write, shared by render (fresh ad) and redraw (cached ad). */
  function paint(ad: AdNextResponse, ctx: ExtensionContext, config: Config, columnsOverride?: number): void {
    const theme = ctx.ui.theme as ThemeLike;
    const columns = columnsOverride ?? process.stdout.columns ?? 80;
    const lines =
      columns >= config.adMinColumns
        ? renderAdCard(ad.creative, ad.click_url, theme, columns)
        : [renderPlainAdLine(ad.creative, ad.click_url, theme, columns)];
    ctx.ui.setWidget(BANNER_WIDGET_ID, lines);
  }

  return {
    async render(deps, ctx, config, columnsOverride) {
      const ad = await fetchAdNext(deps, "banner");
      lastAd = ad;
      if (!ad) {
        ctx.ui.setWidget(BANNER_WIDGET_ID, undefined);
        opts.onBannerAd?.(undefined);
        return;
      }

      paint(ad, ctx, config, columnsOverride);
      // The mirror fires on fetch (a NEW ad), not in paint(): a resize
      // redraw repaints the same ad, and /support's notion of "the current
      // ad" hasn't changed.
      opts.onBannerAd?.(ad.click_url);

      if (lastPostedToken !== ad.click_token) {
        lastPostedToken = ad.click_token;
        await postImpression(deps, ad.ad_id, ad.click_token);
      }
    },

    redraw(ctx, config, columnsOverride) {
      if (!lastAd) return;
      paint(lastAd, ctx, config, columnsOverride);
    },
  };
}
