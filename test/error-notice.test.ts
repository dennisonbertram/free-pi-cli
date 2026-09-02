import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createErrorNoticeExtension, NOTICE_DEDUPE_MS, parseErrorEnvelope } from "../src/error-notice";

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
});
