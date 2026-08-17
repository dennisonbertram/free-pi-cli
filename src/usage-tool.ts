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

function formatStats(stats: MeStatsResponse): string {
  return [
    `tier: ${stats.tier} (cap $${stats.cap_usd_today.toFixed(2)}/day)`,
    `today: spent $${stats.spent_usd_today.toFixed(4)}, remaining $${stats.remaining_usd_today.toFixed(4)}, ${stats.request_count_today} request(s)`,
    `today tokens: ${stats.prompt_tokens_today} prompt / ${stats.completion_tokens_today} completion`,
    `lifetime: spent $${stats.lifetime.spent_usd.toFixed(4)}, ${stats.lifetime.request_count} request(s), ${stats.lifetime.prompt_tokens} prompt / ${stats.lifetime.completion_tokens} completion tokens`,
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
          "Reports the caller's own free-pi spend, remaining daily budget, token counts, and account tier. Read-only, takes no arguments, makes no changes.",
        promptSnippet: "Check your own free-pi usage, spend, and remaining daily budget",
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
