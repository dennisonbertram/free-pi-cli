// Display peg (#credits): a purchased dollar of inference value is shown to the
// user as this many "credits". Chosen so the packs land on round numbers
// ($3.75 -> 50,000 and $7.50 -> 100,000). DISPLAY-ONLY: it never re-enters
// billing or a cap comparison — the ledger (users.credit_usd) and every burn
// stay in USD. The 40000/3 form is exact for both packs. Lives here in
// @freepi/shared so the server (stripe/auth) and the client (meter, CLI) share
// one definition and can never drift.
import { usdToMicros } from "./lane";

export const CREDITS_PER_USD = 40000 / 3;

/** USD (decimal string or number) -> whole credits, for display only. */
export function usdToCredits(usd: string | number): number {
  return Math.round(Number(usd) * CREDITS_PER_USD);
}

/** Next UTC calendar-day boundary — `usage_daily.date` rolls over here. */
export function nextUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/**
 * Formats a refill instant the way the meter prints it: "8:00 PM ET".
 * Uses America/New_York so DST (EDT vs EST) is automatic; the label stays "ET".
 */
export function formatRefillEt(date: Date, timeZone = "America/New_York"): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${formatted} ET`;
}

/**
 * Meter / /usage line for free usage. Credits, never dollars.
 * Example: "12,400 / 15,000 credits left today · refills 8:00 PM ET"
 */
export function formatCreditsLeftLine(remaining: number, allowance: number, refillAt: Date): string {
  const left = remaining.toLocaleString("en-US");
  const total = allowance.toLocaleString("en-US");
  return `${left} / ${total} credits left today · refills ${formatRefillEt(refillAt)}`;
}

export const SLOW_LANE_METER_LINE = "Slow lane: cheapest model until refill";

/** Seconds until `until`, floored at 0. Used for queue_wait Retry-After. */
export function secondsUntil(until: Date, now: Date): number {
  return Math.max(0, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

/**
 * Free-allowance credits still unused today. Display-only. Spent above the
 * cap does not produce a negative — remaining is 0 once the allowance is gone.
 * Integer micros in, whole credits out (the Number conversion is the display
 * boundary; the result never re-enters a cap compare).
 */
export function remainingAllowanceCredits(capUsd: string | number, spentUsd: string | number): number {
  const cap = usdToMicros(capUsd);
  const spent = usdToMicros(spentUsd);
  const rem = spent >= cap ? 0n : cap - spent;
  const whole = rem / 1_000_000n;
  const frac = (rem % 1_000_000n).toString().padStart(6, "0");
  return usdToCredits(`${whole}.${frac}`);
}
