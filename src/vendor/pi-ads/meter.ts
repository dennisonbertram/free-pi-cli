// R7: one-line usage meter fed by GET /me. Refreshed on session start and
// after every turn end (see index.ts). Stateless — unlike banner/inline it
// never posts an impression, so it needs no per-instance dedup state.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdsDeps } from "./api";
import { fetchMe } from "./api";
import { usdToCredits } from "@freepi/shared";
import { inferErrorFromRemainingBudget, mapErrorCode } from "./errors";
import { osc8, renderErrorLine, renderWarningLine, sanitizeText, type ThemeLike } from "./style";

export const METER_WIDGET_ID = "freepi-meter";
// Routine credit balance lives in pi's footer status bar; the widget is kept
// for notices and errors only.
export const METER_STATUS_KEY = "freepi-credits";

/** Standard-lane balance at or below this share of the daily allowance triggers the low-credit warning. */
export const LOW_CREDIT_FRACTION = 0.1;
const BUY_LINK_TEXT = "freepi.ai/buy";

// buy_url carries a token, so it is only the OSC 8 target; the visible text is fixed.
function buyMore(buyUrl: unknown): string {
  const url = typeof buyUrl === "string" ? sanitizeText(buyUrl) : "";
  return url !== "" ? ` · Buy more: ${osc8(BUY_LINK_TEXT, url)}` : "";
}

// 2026-09-01: purchase confirmation. The meter already polls /me every turn;
// when credit_usd rises between two polls in this process, the widget shows a
// "credit added" line for the next CONFIRM_TURNS polls (display-only, no hook,
// no new request). More than one turn because a single prompt often spans
// several turn_ends (tool calls) and a one-poll line vanished before the user
// looked. The baseline is per-process and starts unset, so a restart never
// shows a stale confirmation. Exported reset for tests.
export const CONFIRM_TURNS = 3;
let lastCreditUsd: number | undefined;
let confirm: { addedUsd: number; turnsLeft: number } | undefined;
export function resetMeterState(): void {
  lastCreditUsd = undefined;
  confirm = undefined;
}

export function creditAddedMessage(addedUsd: number): string {
  // #credits: show the round credit figure, never the granted-dollar amount —
  // otherwise a $5 purchase confirming as "$3.75 added" re-exposes the margin.
  return `Payment received — ${usdToCredits(addedUsd).toLocaleString("en-US")} credits added to your balance.`;
}

export async function renderMeter(deps: AdsDeps, ctx: ExtensionContext): Promise<void> {
  const me = await fetchMe(deps);
  // Any widget state below (notice, confirmation, error, hidden) clears the
  // footer balance so the two never disagree; the credits branches set it.
  ctx.ui.setStatus(METER_STATUS_KEY, undefined);
  if (!me) {
    ctx.ui.setWidget(METER_WIDGET_ID, undefined);
    return;
  }

  const theme = ctx.ui.theme as ThemeLike;
  const credit = typeof me.credit_usd === "number" ? me.credit_usd : undefined;
  const added = credit !== undefined && lastCreditUsd !== undefined ? credit - lastCreditUsd : 0;
  lastCreditUsd = credit;
  if (added > 0) confirm = { addedUsd: added, turnsLeft: CONFIRM_TURNS };
  if (confirm && confirm.turnsLeft > 0) {
    confirm.turnsLeft--;
    ctx.ui.setWidget(METER_WIDGET_ID, [renderErrorLine(creditAddedMessage(confirm.addedUsd), theme)]);
    return;
  }
  confirm = undefined;
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
  // Phase 0: credits, never dollars, for free usage. Server-owned fields
  // (optional so an older /me still falls through to the pre-Phase-0 hide).
  if (me.lane === "fallback") {
    ctx.ui.setStatus(METER_STATUS_KEY, theme.fg("muted", "0 credits · slow lane"));
    ctx.ui.setWidget(METER_WIDGET_ID, [
      renderWarningLine(`Out of free credits — slow lane until refill${buyMore(me.buy_url)}`, theme),
    ]);
    return;
  }
  if (
    typeof me.remaining_credits_today === "number" &&
    typeof me.allowance_credits === "number" &&
    typeof me.refill_at === "string"
  ) {
    const refill = new Date(me.refill_at);
    if (!Number.isNaN(refill.getTime()) && me.lane !== "wait") {
      const left = me.remaining_credits_today;
      // Purchased credits ride along in the footer; the low warning below stays on free credits.
      const bought = typeof me.bonus_credits === "number" && me.bonus_credits > 0 ? ` + ${me.bonus_credits.toLocaleString("en-US")}` : "";
      ctx.ui.setStatus(METER_STATUS_KEY, theme.fg("muted", `${left.toLocaleString("en-US")}${bought} credits`));
      const low = left > 0 && left <= me.allowance_credits * LOW_CREDIT_FRACTION;
      ctx.ui.setWidget(
        METER_WIDGET_ID,
        low ? [renderWarningLine(`Low on credits: ${left.toLocaleString("en-US")} left today${buyMore(me.buy_url)}`, theme)] : undefined,
      );
      return;
    }
  }
  const errorCode = inferErrorFromRemainingBudget(me.remaining_usd_today);
  // Founder decision (2026-08-17): never show free-usage dollars. An old
  // server without credit fields still hides the meter until the cap is hit.
  if (errorCode === undefined) {
    ctx.ui.setWidget(METER_WIDGET_ID, undefined);
    return;
  }
  ctx.ui.setWidget(METER_WIDGET_ID, [renderErrorLine(mapErrorCode(errorCode), theme)]);
}
