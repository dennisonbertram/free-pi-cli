// 2026-09-01 (epic #221 follow-up): one clean, server-owned line when the
// server rejects a request. pi itself prints the raw error envelope as JSON
// and retries a 429 three times; an extension cannot suppress either. What it
// can do is read the same error where pi records it — `turn_end` fires for a
// failed turn too, with `message.stopReason === "error"` and
// `message.errorMessage` = `"<status>: <JSON envelope>"` (verified against
// pi 0.84.4 with a live 429 on 2026-09-01; `after_provider_response` does NOT
// fire on this path) — and notify the envelope's `message` once. The text is
// the server's (apps/server/src/http-error.ts), so wording changes with a
// deploy, never a CLI release.
//
// Lives in packages/cli, not packages/pi-ads: the ads package's structural
// gate pins its hook surface; this is a separate, closed-listed extension.
import { formatLimitNotice } from "@freepi/shared";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

export interface CreateErrorNoticeOptions {
  /** Injected clock for the dedupe window; defaults to Date.now. */
  now?: () => number;
  /** Timezone for long-wait "back at" clocks. Unset = the process local zone. */
  timeZone?: string;
}

/** pi retries a 429 up to 3 times within seconds; one notice per code per window is enough. */
export const NOTICE_DEDUPE_MS = 15_000;

export interface ParsedEnvelope {
  status: number;
  code: string;
  message: string;
  limit?: string;
  retry_after_seconds?: number;
  clears_at?: string;
  remaining_credits_today?: number;
  allowance_credits?: number;
  lane?: "slow";
  hourly_ceiling?: number;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Parses pi's `"<status>: {json}"` errorMessage into the server envelope. Returns undefined for anything else (never throws). */
export function parseErrorEnvelope(errorMessage: unknown): ParsedEnvelope | undefined {
  if (typeof errorMessage !== "string") return undefined;
  const m = /^(\d{3}): (\{[\s\S]*\})\s*$/.exec(errorMessage);
  if (!m) return undefined;
  try {
    const body = JSON.parse(m[2]!) as {
      message?: unknown;
      code?: unknown;
      limit?: unknown;
      retry_after_seconds?: unknown;
      clears_at?: unknown;
      remaining_credits_today?: unknown;
      allowance_credits?: unknown;
      lane?: unknown;
      hourly_ceiling?: unknown;
      error?: { message?: unknown; code?: unknown };
    };
    const message = body.message ?? body.error?.message;
    const code = body.code ?? body.error?.code;
    if (typeof message !== "string" || message.trim() === "") return undefined;
    const parsed: ParsedEnvelope = {
      status: Number(m[1]),
      code: typeof code === "string" ? code : "unknown",
      message,
    };
    const limit = optionalString(body.limit);
    const retryAfter = optionalNumber(body.retry_after_seconds);
    const clearsAt = optionalString(body.clears_at);
    const remaining = optionalNumber(body.remaining_credits_today);
    const allowance = optionalNumber(body.allowance_credits);
    if (limit) parsed.limit = limit;
    if (retryAfter !== undefined) parsed.retry_after_seconds = retryAfter;
    if (clearsAt) parsed.clears_at = clearsAt;
    if (remaining !== undefined) parsed.remaining_credits_today = remaining;
    if (allowance !== undefined) parsed.allowance_credits = allowance;
    const ceiling = optionalNumber(body.hourly_ceiling);
    if (body.lane === "slow") parsed.lane = "slow";
    if (ceiling !== undefined) parsed.hourly_ceiling = ceiling;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Plain limit line from structured extras; falls back to the server's message. */
export function formatLimitEnvelope(env: ParsedEnvelope, opts?: { timeZone?: string }): string {
  // concurrent_session carries a recovery hint (/close-other-session) that the generic line would drop.
  if (env.code === "concurrent_session" || typeof env.remaining_credits_today !== "number") return env.message;
  return formatLimitNotice(
    {
      limit: env.limit ?? env.code,
      retry_after_seconds: env.retry_after_seconds,
      clears_at: env.clears_at,
      remaining_credits_today: env.remaining_credits_today,
      allowance_credits: env.allowance_credits,
      lane: env.lane,
      hourly_ceiling: env.hourly_ceiling,
    },
    { localTime: true, timeZone: opts?.timeZone },
  );
}

export function createErrorNoticeExtension(opts: CreateErrorNoticeOptions = {}): InlineExtension {
  const lastAt = new Map<string, number>();
  const now = opts.now ?? Date.now;
  const timeZone = opts.timeZone;
  return {
    name: "free-pi-error-notice",
    factory(pi: ExtensionAPI) {
      pi.on("turn_end", (event, ctx) => {
        const msg = event.message as { stopReason?: string; errorMessage?: unknown } | undefined;
        if (!msg || msg.stopReason !== "error") return;
        const env = parseErrorEnvelope(msg.errorMessage);
        if (!env) return;
        const t = now();
        if (t - (lastAt.get(env.code) ?? -Infinity) < NOTICE_DEDUPE_MS) return;
        lastAt.set(env.code, t);
        ctx.ui.notify(formatLimitEnvelope(env, { timeZone }), env.status >= 500 ? "error" : "warning");
      });
    },
  };
}
