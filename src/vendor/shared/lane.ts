// Phase 0 credits lane: a pure function so the completions gate, /me/stats,
// and unit tests share one decision. Money comparisons are integer micros —
// never a JS float (CLAUDE.md).
import type { UsageLane } from "./api";

export interface LaneInput {
  spentUsd: string | number;
  creditUsd: string | number;
  capUsd: string | number;
  fallbackSpentUsd: string | number;
  fallbackLaneUsd: string | number;
  globalSpentUsd: string | number;
  globalCapUsd: string | number;
  /** Basis points of global cap that must remain as headroom (1000 = 10%). */
  minHeadroomBps: number;
}

export interface LaneDecision {
  lane: UsageLane;
  admit: boolean;
  reject?: "daily_cap" | "queue_wait";
}

/** Parses a decimal string (or a config number) into integer micro-dollars. */
export function usdToMicros(value: string | number): bigint {
  const s = typeof value === "number" ? value.toFixed(6) : String(value).trim();
  const negative = s.startsWith("-");
  const [whole = "0", frac = ""] = (negative ? s.slice(1) : s).split(".");
  const micros = BigInt(whole || "0") * 1_000_000n + BigInt(`${frac}000000`.slice(0, 6));
  return negative ? -micros : micros;
}

/** Display-only: integer micros → JS number at the API boundary (never fed back into a cap). */
export function microsToUsdNumber(micros: bigint): number {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return Number(`${negative ? "-" : ""}${whole}.${frac}`);
}

/**
 * Global remaining spend is strictly greater than `minHeadroomBps` / 10_000 of
 * the global cap. Cross-multiplied integers: spent * 10000 < cap * (10000 - bps).
 * A zero or negative cap is never "ok" (nothing to share).
 */
export function globalHeadroomOk(
  globalSpentUsd: string | number,
  globalCapUsd: string | number,
  minHeadroomBps: number,
): boolean {
  const spent = usdToMicros(globalSpentUsd);
  const cap = usdToMicros(globalCapUsd);
  if (cap <= 0n) return false;
  const bps = BigInt(Math.max(0, Math.trunc(minHeadroomBps)));
  if (bps >= 10000n) return false;
  return spent * 10000n < cap * (10000n - bps);
}

/**
 * At the wall = free allowance spent AND no credit left. `creditUsd` is the
 * REMAINING balance (addUsage already debits over-cap spend from it), so it
 * must not be added to the cap again.
 */
export function atDailyWall(spentUsd: string | number, capUsd: string | number, creditUsd: string | number): boolean {
  return usdToMicros(spentUsd) >= usdToMicros(capUsd) && usdToMicros(creditUsd) <= 0n;
}

/**
 * Admission + display lane at the daily-cap gate.
 *
 * - still under allowance + credit → standard (admit)
 * - over that, fallback remaining, global headroom > 10% → fallback (admit)
 * - over that, global headroom low → wait / queue_wait
 * - over that, fallback exhausted, headroom ok → wait / daily_cap
 */
export function decideLane(input: LaneInput): LaneDecision {
  if (!atDailyWall(input.spentUsd, input.capUsd, input.creditUsd)) {
    return { lane: "standard", admit: true };
  }

  const fallbackLeft = usdToMicros(input.fallbackSpentUsd) < usdToMicros(input.fallbackLaneUsd);
  const headroomOk = globalHeadroomOk(input.globalSpentUsd, input.globalCapUsd, input.minHeadroomBps);

  if (fallbackLeft && headroomOk) {
    return { lane: "fallback", admit: true };
  }
  if (!headroomOk) {
    return { lane: "wait", admit: false, reject: "queue_wait" };
  }
  return { lane: "wait", admit: false, reject: "daily_cap" };
}
