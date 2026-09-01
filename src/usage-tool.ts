// U5 (#17 client side): a read-only pi tool that reports the caller's own
// free-pi usage (spend, remaining budget, token counts, account tier) by
// calling GET /me/stats with the CLI's own JWT.
//
// Deliberately a new module in packages/cli, never added to packages/pi-ads
// (KTD5): packages/pi-ads/src/sandbox.test.ts structurally asserts the ads
// extension never calls registerTool (its "message surface" is off-limits —
// see that file's own comment on KTD9/R5), and this tool must never be
// reachable from ad content even in principle. A separate module keeps that
// invariant intact and needs no new workspace package.
//
// R9: read-only (GET only; parameters is an empty schema, so no argument
// exists that could mutate anything), scoped to the caller's own JWT (the
// same bearer token the cli already holds for /v1/chat/completions and
// /me — see pi-launch.ts's getToken wiring), no write path exists anywhere
// in this file.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MeStatsResponse } from "@freepi/shared";

export interface CreateUsageToolOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
}

type UsageToolDetails = MeStatsResponse | { ok: false };

// #28 R20a: the one legitimate custom tool name outside SAFE_TOOLS — needed
// by pi-launch.ts's tool-guard allowlist (tool-guard.ts) and the SDK's own
// strict `tools` allowlist so this tool isn't blocked as if it were rogue.
export const USAGE_TOOL_NAME = "free_pi_usage";

const PARAMS = Type.Object({});

/** Display-only: whole-percent share of today's free allowance that is spent (founder decision 2026-09-01: never show free-usage dollars). */
export function percentUsed(spentUsd: number, capUsd: number): number {
  if (!(capUsd > 0)) return 100;
  return Math.min(100, Math.max(0, Math.round((spentUsd / capUsd) * 100)));
}

export function formatStats(stats: MeStatsResponse): string {
  // Founder decision (2026-09-01, same reasoning as the meter's 2026-08-17
  // decision): free usage is never shown as a dollar amount — not the cap, not
  // today's spend, not lifetime spend — only as a percentage of today's
  // allowance. Purchased credit IS money the user paid, so it stays in dollars.
  // #227: credit_usd arrived with the #229 server; an older server omits it, so
  // the line is guarded at runtime.
  const credit = (stats as Partial<MeStatsResponse>).credit_usd;
  return [
    `tier: ${stats.tier}`,
    `today: ${percentUsed(stats.spent_usd_today, stats.cap_usd_today)}% of your free daily allowance used, ${stats.request_count_today} request(s)`,
    ...(typeof credit === "number" ? [`credit: $${credit.toFixed(2)} purchased usage remaining`] : []),
    `today tokens: ${stats.prompt_tokens_today} prompt / ${stats.completion_tokens_today} completion`,
    `lifetime: ${stats.lifetime.request_count} request(s), ${stats.lifetime.prompt_tokens} prompt / ${stats.lifetime.completion_tokens} completion tokens`,
  ].join("\n");
}

export function createUsageToolExtension(opts: CreateUsageToolOptions): InlineExtension {
  return {
    name: "free-pi-usage-tool",
    factory(pi: ExtensionAPI) {
      pi.registerTool({
        name: USAGE_TOOL_NAME,
        label: "My Usage",
        description:
          "Reports how much of the caller's free daily allowance is used (as a percentage), purchased credit, token counts, and account tier. Read-only, takes no arguments, makes no changes.",
        promptSnippet: "Check your own free-pi usage and remaining daily allowance",
        parameters: PARAMS,
        async execute() {
          try {
            const token = await opts.getToken();
            const doFetch = opts.fetchImpl ?? fetch;
            const res = await doFetch(`${opts.baseUrl}/me/stats`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) {
              return {
                content: [{ type: "text" as const, text: `Could not fetch usage (HTTP ${res.status}).` }],
                details: { ok: false } as UsageToolDetails,
              };
            }
            const stats = (await res.json()) as MeStatsResponse;
            return {
              content: [{ type: "text" as const, text: formatStats(stats) }],
              details: stats as UsageToolDetails,
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `Could not fetch usage: ${String(err)}` }],
              details: { ok: false } as UsageToolDetails,
            };
          }
        },
      });
    },
  };
}
