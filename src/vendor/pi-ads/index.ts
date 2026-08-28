// pi extension entry point (U7). KTD9 / R5: this extension registers only
// lifecycle/UI hooks (session_start, turn_end, session_shutdown) — never
// context, before_provider_request, before_agent_start, message_*, tool_*,
// or agent_*. See src/sandbox.test.ts for the enforced proof. Ad content
// only ever reaches the terminal through ctx.ui.setWidget; it never touches
// pi.sendMessage / pi.sendUserMessage / pi.appendEntry / the session.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "@freepi/shared";
import type { AdsDeps } from "./api";
import { createBannerRenderer } from "./banner";
import { createInlineRenderer } from "./inline";
import { renderMeter } from "./meter";

export interface CreateAdsExtensionOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  sessionId: string;
  fetchImpl?: typeof fetch;
}

const BANNER_REFRESH_MS = 10 * 60 * 1000;

/** Init function the cli calls with baseUrl + a token getter, decoupled from any credential-store detail. */
export function createAdsExtension(opts: CreateAdsExtensionOptions): InlineExtension {
  const deps: AdsDeps = {
    baseUrl: opts.baseUrl,
    getToken: opts.getToken,
    sessionId: opts.sessionId,
    fetchImpl: opts.fetchImpl,
  };
  const config = loadConfig();

  return {
    name: "free-pi-ads",
    factory(pi: ExtensionAPI) {
      const banner = createBannerRenderer();
      const inline = createInlineRenderer();
      // Timers are session-scoped resources: started in session_start, torn
      // down in session_shutdown, per pi's own extension guidance (never
      // started from the factory itself).
      let bannerInterval: ReturnType<typeof setInterval> | undefined;

      pi.on("session_start", async (_event, ctx) => {
        inline.reset(ctx);

        await Promise.all([banner.render(deps, ctx, config), renderMeter(deps, ctx)]);

        if (bannerInterval) clearInterval(bannerInterval);
        bannerInterval = setInterval(() => {
          void banner.render(deps, ctx, config);
        }, BANNER_REFRESH_MS);
        (bannerInterval as unknown as { unref?: () => void }).unref?.();
      });

      pi.on("turn_end", async (_event, ctx) => {
        await Promise.all([inline.onTurnEnd(deps, ctx, config), renderMeter(deps, ctx)]);
      });

      pi.on("session_shutdown", () => {
        if (bannerInterval) {
          clearInterval(bannerInterval);
          bannerInterval = undefined;
        }
      });
    },
  };
}
