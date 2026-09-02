// #226 (6/8 of #221): a pi tool that opens the server's buy-credits page.
// GET /me with the CLI's own JWT, read the fresh `buy_url` (never cached —
// the token is short-lived by design), open it with browser.ts's opener AND
// return the URL as text (SSH sessions/containers have no browser — see
// browser.ts's own comment that printing is the primary path).
//
// Deliberately a new module in packages/cli, never added to packages/pi-ads
// (KTD5, same reasoning as usage-tool.ts): packages/pi-ads/src/sandbox.test.ts
// structurally asserts the ads extension never calls registerTool (its
// "message surface" is off-limits — see that file's own comment on
// KTD9/R5), and this tool must never be reachable from ad content even in
// principle. A separate module keeps that invariant intact and needs no new
// workspace package.
//
// R9: read-only (GET only; parameters is an empty schema, so no argument
// exists that could mutate anything), scoped to the caller's own JWT (the
// same bearer token the cli already holds for /v1/chat/completions and
// /me — see pi-launch.ts's getToken wiring), no write path exists anywhere
// in this file.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MeResponse } from "@freepi/shared";
import { openBrowser } from "./browser";

/** One place resolves "where do I buy": shared by the free_pi_buy_credits tool and the /buy-credits slash command. Never throws. */
export type BuyPage = { kind: "url"; url: string } | { kind: "unavailable" } | { kind: "error"; text: string };

export async function resolveBuyPage(opts: {
  baseUrl: string;
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
}): Promise<BuyPage> {
  try {
    const token = await opts.getToken();
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${opts.baseUrl}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { kind: "error", text: `Could not fetch the buy page (HTTP ${res.status}).` };
    const me = (await res.json()) as MeResponse;
    return me.buy_url ? { kind: "url", url: me.buy_url } : { kind: "unavailable" };
  } catch (err) {
    return { kind: "error", text: `Could not fetch the buy page: ${String(err)}` };
  }
}

export const BUY_NOT_AVAILABLE_TEXT = "Buying credits is not available on this server yet.";

export function buyPageText(url: string): string {
  return `Opening the buy page in your browser. If it did not open (for example over SSH), visit:\n${url}\n\nPacks: $5 → 50,000 credits, $10 → 100,000 credits. Card or USDC.`;
}

export interface CreateBuyToolOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  openBrowserImpl?: typeof openBrowser;
}

type BuyToolDetails = { buy_url: string } | { available: false } | { ok: false };

// #226 R20a: the second legitimate custom tool name outside SAFE_TOOLS —
// needed by pi-launch.ts's tool-guard allowlist (tool-guard.ts) and the
// SDK's own strict `tools` allowlist so this tool isn't blocked as if it
// were rogue.
export const BUY_TOOL_NAME = "free_pi_buy_credits";

const PARAMS = Type.Object({});

export function createBuyToolExtension(opts: CreateBuyToolOptions): InlineExtension {
  return {
    name: "free-pi-buy-tool",
    factory(pi: ExtensionAPI) {
      pi.registerTool({
        name: BUY_TOOL_NAME,
        label: "Buy Credits",
        description:
          "Opens the free-pi buy-credits page in your browser (and prints the URL, for SSH sessions with no browser). Read-only against the server, takes no arguments.",
        promptSnippet: "Buy more free-pi credits",
        parameters: PARAMS,
        async execute() {
          const page = await resolveBuyPage(opts);
          if (page.kind === "error") {
            return { content: [{ type: "text" as const, text: page.text }], details: { ok: false } as BuyToolDetails };
          }
          if (page.kind === "unavailable") {
            return {
              content: [{ type: "text" as const, text: BUY_NOT_AVAILABLE_TEXT }],
              details: { available: false } as BuyToolDetails,
            };
          }
          (opts.openBrowserImpl ?? openBrowser)(page.url);
          return {
            content: [{ type: "text" as const, text: buyPageText(page.url) }],
            details: { buy_url: page.url } as BuyToolDetails,
          };
        },
      });
    },
  };
}
