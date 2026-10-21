import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createErrorNoticeExtension,
  formatLimitEnvelope,
  NOTICE_DEDUPE_MS,
  parseErrorEnvelope,
} from "../src/error-notice";

const MSG = "out of free usage today (young tier). Buy more at https://api.test/buy/t — $5 or $10, card or USDC. Free usage resets at 00:00 UTC.";
// Exactly the shape pi 0.84.4 puts in message.errorMessage for a free-pi 429 (observed live 2026-09-01).
const ERR = `429: ${JSON.stringify({ message: MSG, code: "daily_cap", error: { message: MSG, code: "daily_cap", type: "free_pi_error" } })}`;

describe("parseErrorEnvelope", () => {
  test("parses pi's '<status>: {envelope}' into status/code/message", () => {
    expect(parseErrorEnvelope(ERR)).toEqual({ status: 429, code: "daily_cap", message: MSG });
  });
  test("tolerates an envelope with only error.message, and rejects everything else", () => {
    expect(parseErrorEnvelope('502: {"error":{"message":"upstream responded 401","code":"upstream_error"}}')).toEqual({ status: 502, code: "upstream_error", message: "upstream responded 401" });
    expect(parseErrorEnvelope("429: not json")).toBeUndefined();
    expect(parseErrorEnvelope("socket hang up")).toBeUndefined();
    expect(parseErrorEnvelope(undefined)).toBeUndefined();
    expect(parseErrorEnvelope('429: {"code":"x"}')).toBeUndefined();
  });
});

describe("free-pi-error-notice extension", () => {
  function harness(nowValues: number[]) {
    const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
    const notes: Array<{ m: string; t?: string }> = [];
    let i = 0;
    const ext = createErrorNoticeExtension({ now: () => nowValues[Math.min(i++, nowValues.length - 1)]! });
    (ext as { factory: (pi: ExtensionAPI) => void }).factory({ on: (name: string, h: (event: unknown, ctx: unknown) => unknown) => { handlers[name] = h; } } as unknown as ExtensionAPI);
    const ctx = { ui: { notify: (m: string, t?: string) => void notes.push({ m, t }) } };
    return { handlers, notes, ctx };
  }
  test("registers only turn_end; an error turn notifies the server's message once per dedupe window (pi retries 3x); normal turns and non-envelope errors are ignored", () => {
    const { handlers, notes, ctx } = harness([0, 1000, 2000, NOTICE_DEDUPE_MS + 1]);
    expect(Object.keys(handlers)).toEqual(["turn_end"]);
    const h = handlers["turn_end"]!;
    h({ type: "turn_end", message: { role: "assistant", stopReason: "stop" } }, ctx);
    h({ type: "turn_end", message: { role: "assistant", stopReason: "error", errorMessage: "socket hang up" } }, ctx);
    h({ type: "turn_end", message: { stopReason: "error", errorMessage: ERR } }, ctx);
    h({ type: "turn_end", message: { stopReason: "error", errorMessage: ERR } }, ctx);
    h({ type: "turn_end", message: { stopReason: "error", errorMessage: ERR } }, ctx);
    expect(notes).toEqual([{ m: MSG, t: "warning" }]);
    h({ type: "turn_end", message: { stopReason: "error", errorMessage: ERR } }, ctx);
    expect(notes).toHaveLength(2);
  });
  test("a 5xx envelope is an error-level notice", () => {
    const { handlers, notes, ctx } = harness([0]);
    handlers["turn_end"]!({ type: "turn_end", message: { stopReason: "error", errorMessage: '502: {"message":"upstream responded 401","code":"upstream_error"}' } }, ctx);
    expect(notes).toEqual([{ m: "upstream responded 401", t: "error" }]);
  });

  test("a limit envelope with remaining credits formats a plain local-time line", () => {
    const hourly = `429: ${JSON.stringify({
      code: "hourly_ceiling",
      message: "hourly limit, back in 12 min, 4,200 credits left today",
      limit: "hourly_ceiling",
      retry_after_seconds: 720,
      remaining_credits_today: 4200,
      allowance_credits: 15000,
    })}`;
    const { handlers, notes, ctx } = harness([0]);
    handlers["turn_end"]!({ type: "turn_end", message: { stopReason: "error", errorMessage: hourly } }, ctx);
    expect(notes).toEqual([{ m: "hourly limit, back in 12 min, 4,200 credits left today", t: "warning" }]);
  });
});

describe("slow-lane hourly notice", () => {
  const base = { status: 429, code: "hourly_ceiling", message: "server text", limit: "hourly_ceiling", retry_after_seconds: 720, remaining_credits_today: 0, allowance_credits: 15000 };
  test("explains the slow lane and points to extra credits", () => {
    const env = parseErrorEnvelope(`429: ${JSON.stringify({ ...base, lane: "slow", hourly_ceiling: 10 })}`)!;
    const text = formatLimitEnvelope(env);
    expect(text).toBe(
      "You've used today's free allowance, so you're on the slow lane (10 requests an hour). Back in 12 min \u2014 or get credits at freepi.ai/extra-credits to keep going at full speed.",
    );
  });
  test("the regular hourly line is unchanged without lane", () => {
    expect(formatLimitEnvelope(base)).toBe("hourly limit, back in 12 min, 0 credits left today");
  });
});

describe("concurrent_session notice", () => {
  test("keeps the server's recovery hint instead of the generic limit line", () => {
    const msg = "another session is active. Run /close-other-session to take over.";
    const env = { status: 409, code: "concurrent_session", message: msg, limit: "concurrent_session", remaining_credits_today: 4200, allowance_credits: 15000 };
    expect(formatLimitEnvelope(env)).toBe(msg);
  });
});

describe("formatLimitEnvelope", () => {
  test("falls back to the server message when extras are missing", () => {
    expect(formatLimitEnvelope({ status: 429, code: "daily_cap", message: MSG })).toBe(MSG);
  });

  test("uses local time for a long wait", () => {
    expect(
      formatLimitEnvelope(
        {
          status: 429,
          code: "daily_cap",
          message: "daily limit, back in 240 min, 0 credits left today",
          limit: "daily_cap",
          retry_after_seconds: 4 * 60 * 60,
          clears_at: "2026-10-15T00:00:00.000Z",
          remaining_credits_today: 0,
          allowance_credits: 15000,
        },
        { timeZone: "America/New_York" },
      ),
    ).toBe("daily limit, back at 8:00 PM, 0 credits left today");
  });
});
