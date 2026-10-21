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

/** User-facing labels for quota/rate limit codes. Never mention traces, session logging, or training. */
export const LIMIT_NOTICE_LABELS: Record<string, string> = {
  hourly_ceiling: "hourly limit",
  daily_cap: "daily limit",
  rolling_cap: "rolling limit",
  global_cap: "service daily limit",
  queue_wait: "queue wait",
  concurrent: "one request at a time",
  concurrent_session: "another session is active",
};

export interface LimitNoticeFields {
  limit: string;
  retry_after_seconds?: number;
  clears_at?: string;
  remaining_credits_today: number;
  allowance_credits?: number;
  /** "slow" = rejected in the fallback (slow) lane; only set with limit hourly_ceiling. */
  lane?: "slow";
  /** The hourly request ceiling that applied, shown in the slow-lane line. */
  hourly_ceiling?: number;
}

export const EXTRA_CREDITS_URL = "freepi.ai/extra-credits";

/** Waits at or above this many seconds are shown as a clock time, not minutes. */
export const LIMIT_NOTICE_LOCAL_TIME_AFTER_SECONDS = 90 * 60;

/**
 * Plain limit line for the CLI and the 429 body.
 * Example: "hourly limit, back in 12 min, 4,200 credits left today"
 * When `localTime` is set and the wait is long, "back at 8:00 PM" uses the
 * local (or supplied) timezone. Short waits stay in minutes.
 */
export function formatLimitNotice(
  fields: LimitNoticeFields,
  opts: { now?: Date; timeZone?: string; localTime?: boolean } = {},
): string {
  const slow = fields.lane === "slow" && fields.limit === "hourly_ceiling" && fields.hourly_ceiling != null;
  const label = slow
    ? `You've used today's free allowance, so you're on the slow lane (${fields.hourly_ceiling!.toLocaleString("en-US")} requests an hour).`
    : (LIMIT_NOTICE_LABELS[fields.limit] ?? fields.limit.replace(/_/g, " "));
  const parts = [label];
  const retry = fields.retry_after_seconds;
  if (retry != null && retry > 0) {
    const useClock =
      Boolean(opts.localTime) &&
      Boolean(fields.clears_at) &&
      retry >= LIMIT_NOTICE_LOCAL_TIME_AFTER_SECONDS;
    if (useClock) {
      const formatted = new Intl.DateTimeFormat("en-US", {
        timeZone: opts.timeZone,
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date(fields.clears_at!));
      parts.push(`back at ${formatted}`);
    } else {
      parts.push(`back in ${Math.max(1, Math.ceil(retry / 60))} min`);
    }
  }
  if (slow) {
    const wait = parts.length > 1 ? ` ${parts[1]![0]!.toUpperCase()}${parts[1]!.slice(1)} \u2014 or get` : " Get";
    return `${label}${wait} credits at ${EXTRA_CREDITS_URL} to keep going at full speed.`;
  }
  parts.push(`${fields.remaining_credits_today.toLocaleString("en-US")} credits left today`);
  return parts.join(", ");
}
