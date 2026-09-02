// R7: one-line usage meter fed by GET /me. Refreshed on session start and
// after every turn end (see index.ts). Stateless — unlike banner/inline it
// never posts an impression, so it needs no per-instance dedup state.
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdsDeps } from "./api";
import { fetchMe } from "./api";
import { inferErrorFromRemainingBudget, mapErrorCode } from "./errors";
import { renderErrorLine, sanitizeText, type ThemeLike } from "./style";

export const METER_WIDGET_ID = "freepi-meter";

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
  return `Payment received — $${addedUsd.toFixed(2)} of usage added to your balance.`;
}

export async function renderMeter(deps: AdsDeps, ctx: ExtensionContext): Promise<void> {
  const me = await fetchMe(deps);
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
