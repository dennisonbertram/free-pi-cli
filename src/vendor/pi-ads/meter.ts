// R7: one-line usage meter fed by GET /me. Refreshed on session start and
// after every turn end (see index.ts). Stateless — unlike banner/inline it
// never posts an impression, so it needs no per-instance dedup state.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdsDeps } from "./api";
import { fetchMe } from "./api";
import { inferErrorFromRemainingBudget, mapErrorCode } from "./errors";
import { renderErrorLine, sanitizeText, type ThemeLike } from "./style";

export const METER_WIDGET_ID = "freepi-meter";

export async function renderMeter(deps: AdsDeps, ctx: ExtensionContext): Promise<void> {
  const me = await fetchMe(deps);
  if (!me) {
    ctx.ui.setWidget(METER_WIDGET_ID, undefined);
    return;
  }

  const theme = ctx.ui.theme as ThemeLike;
  // #225 (epic #221): a server-supplied `notice` wins over the client-baked
  // string, so the offer/price/URL are server-owned after this one release.
  // Display-only — rendered as sanitized plain text through the same widget,
  // never interpreted, never a message or tool surface (sandbox.test.ts).
  // Absent (old server) → the exact pre-#225 behavior below.
  const notice = typeof me.notice === "string" ? sanitizeText(me.notice).trim() : "";
  if (notice !== "") {
    ctx.ui.setWidget(METER_WIDGET_ID, [renderErrorLine(notice, theme)]);
    return;
  }
  const errorCode = inferErrorFromRemainingBudget(me.remaining_usd_today);
  // Founder decision (2026-08-17): do NOT show the normal "free budget today:
  // $X remaining" line — the dollar amount reads as "cheap". Only surface a
  // message when the daily cap is actually hit (that message carries no dollar
  // figure). Revisit later with a clearer usage indicator.
  if (errorCode === undefined) {
    ctx.ui.setWidget(METER_WIDGET_ID, undefined);
    return;
  }
  ctx.ui.setWidget(METER_WIDGET_ID, [renderErrorLine(mapErrorCode(errorCode), theme)]);
}
