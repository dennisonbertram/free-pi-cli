// R4: inline ad card after every `adInlineTurnFrequency`-th assistant turn
// (default 5), shown for exactly one turn, then cleared. Driven entirely
// from turn_end (see index.ts) — no turn_start hook needed: the card set at
// turn N's turn_end is cleared at the *next* turn_end before that turn's own
// cadence check runs, which is "visible for one turn" without adding a
// second hook to the extension's registered surface.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { fetchAdNext, postImpression } from "./api";
import { renderAdCard, renderPlainAdLine, type ThemeLike } from "./style";

export const INLINE_WIDGET_ID = "freepi-ad-inline";

export interface InlineRenderer {
  onTurnEnd(deps: AdsDeps, ctx: ExtensionContext, config: Config, columnsOverride?: number): Promise<void>;
  /** Reset turn count / visibility — called on session_start so a /new or /resume starts cadence fresh. */
  reset(ctx: ExtensionContext): void;
}

export function createInlineRenderer(): InlineRenderer {
  let turnCount = 0;
  let inlineVisible = false;
  let lastPostedToken: string | undefined;

  return {
    async onTurnEnd(deps, ctx, config, columnsOverride) {
      turnCount += 1;

      if (inlineVisible) {
        ctx.ui.setWidget(INLINE_WIDGET_ID, undefined);
        inlineVisible = false;
      }

      if (turnCount % config.adInlineTurnFrequency !== 0) return;

      const ad = await fetchAdNext(deps, "inline");
      if (!ad) return;

      const theme = ctx.ui.theme as ThemeLike;
      const columns = columnsOverride ?? process.stdout.columns ?? 80;
      const lines =
        columns >= config.adMinColumns
          ? renderAdCard(ad.creative, ad.click_url, theme, columns)
          : [renderPlainAdLine(ad.creative, ad.click_url, theme, columns)];

      ctx.ui.setWidget(INLINE_WIDGET_ID, lines, { placement: "belowEditor" });
      inlineVisible = true;

      if (lastPostedToken !== ad.click_token) {
        lastPostedToken = ad.click_token;
        await postImpression(deps, ad.ad_id, ad.click_token);
      }
    },

    reset(ctx) {
      turnCount = 0;
      if (inlineVisible) ctx.ui.setWidget(INLINE_WIDGET_ID, undefined);
      inlineVisible = false;
    },
  };
}
