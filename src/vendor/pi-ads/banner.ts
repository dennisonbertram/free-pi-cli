// R4/R6: persistent ad banner above the editor. Refreshed on session start
// and every 10 minutes (index.ts owns the interval). Empty slot (204) or a
// fetch failure both clear the widget outright — never a stale or half-drawn
// frame, never anything that blocks the chat turn.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { fetchAdNext, postImpression } from "./api";
import { renderAdCard, renderPlainAdLine, type ThemeLike } from "./style";

export const BANNER_WIDGET_ID = "freepi-ad";

export interface BannerRenderer {
  /** Fetch + render the banner slot. `columnsOverride` is a testing seam; production reads the real terminal width. */
  render(deps: AdsDeps, ctx: ExtensionContext, config: Config, columnsOverride?: number): Promise<void>;
}

/**
 * Per-extension-instance renderer. Tracks the last click_token an impression
 * was posted for so a re-render of the *same* fetched ad (a repaint, not a
 * new /ads/next call) never double-posts — each /ads/next call always mints
 * a fresh click_token server-side, so this dedup only ever suppresses actual
 * repaints, never distinct impressions.
 */
export function createBannerRenderer(): BannerRenderer {
  let lastPostedToken: string | undefined;

  return {
    async render(deps, ctx, config, columnsOverride) {
      const ad = await fetchAdNext(deps, "banner");
      if (!ad) {
        ctx.ui.setWidget(BANNER_WIDGET_ID, undefined);
        return;
      }

      const theme = ctx.ui.theme as ThemeLike;
      const columns = columnsOverride ?? process.stdout.columns ?? 80;
      const lines =
        columns >= config.adMinColumns
          ? renderAdCard(ad.creative, ad.click_url, theme, columns)
          : [renderPlainAdLine(ad.creative, ad.click_url, theme, columns)];

      ctx.ui.setWidget(BANNER_WIDGET_ID, lines);

      if (lastPostedToken !== ad.click_token) {
        lastPostedToken = ad.click_token;
        await postImpression(deps, ad.ad_id, ad.click_token);
      }
    },
  };
}
