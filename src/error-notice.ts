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
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

export interface CreateErrorNoticeOptions {
  /** Injected clock for the dedupe window; defaults to Date.now. */
  now?: () => number;
}

/** pi retries a 429 up to 3 times within seconds; one notice per code per window is enough. */
export const NOTICE_DEDUPE_MS = 15_000;

export interface ParsedEnvelope {
  status: number;
  code: string;
  message: string;
}

/** Parses pi's `"<status>: {json}"` errorMessage into the server envelope. Returns undefined for anything else (never throws). */
export function parseErrorEnvelope(errorMessage: unknown): ParsedEnvelope | undefined {
  if (typeof errorMessage !== "string") return undefined;
  const m = /^(\d{3}): (\{[\s\S]*\})\s*$/.exec(errorMessage);
  if (!m) return undefined;
  try {
    const body = JSON.parse(m[2]!) as { message?: unknown; code?: unknown; error?: { message?: unknown; code?: unknown } };
    const message = body.message ?? body.error?.message;
    const code = body.code ?? body.error?.code;
    if (typeof message !== "string" || message.trim() === "") return undefined;
    return { status: Number(m[1]), code: typeof code === "string" ? code : "unknown", message };
  } catch {
    return undefined;
  }
}

export function createErrorNoticeExtension(opts: CreateErrorNoticeOptions = {}): InlineExtension {
  const lastAt = new Map<string, number>();
  const now = opts.now ?? Date.now;
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
        ctx.ui.notify(env.message, env.status >= 500 ? "error" : "warning");
      });
    },
  };
}
