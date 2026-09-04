// 0.2.6: free-pi's slash commands — /close-other-session (self-service lease
// reset), /whats-new (bundled changelog), /update (self-update trigger), and
// 0.2.12: /buy-credits (opens the buy page; epic #221). One inline extension
// (free-pi-commands) registers all four. Grouped here rather than in
// usage-tool, which stays read-only.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { SessionResetResponseSchema } from "@freepi/shared";
import { CHANGELOG_HIGHLIGHTS } from "./changelog";
import { openBrowser } from "./browser";
import { BUY_NOT_AVAILABLE_TEXT, buyPageText, resolveBuyPage } from "./buy-tool";
import { fetchUsageText } from "./usage-tool";

export interface CreateCommandsOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to browser.ts's opener. */
  openBrowserImpl?: typeof openBrowser;
  /** KTD7: reads the click URL of the banner ad currently shown, set by
   * pi-ads' onBannerAd callback. Undefined when no ad is shown. */
  getAdvertiserUrl?: () => string | undefined;
}

/** Minimal shape of the command context we use — just the notify surface. */
export interface NotifyContext {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

// ---- /close-other-session -------------------------------------------------

/**
 * Force-releases the caller's own stuck session lease via POST /session/reset.
 * Never throws — every failure resolves to a friendly notify line.
 */
export async function closeOtherSession(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const token = await opts.getToken();
    const res = await fetchImpl(new URL("/session/reset", opts.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      ctx.ui.notify("Couldn't reset your session (the server said no) — try again in a moment.", "error");
      return;
    }
    const parsed = SessionResetResponseSchema.safeParse(await res.json());
    const released = parsed.success ? parsed.data.released : false;
    ctx.ui.notify(
      released
        ? "Cleared your other session — you can start a new one now."
        : "No other session was running.",
      "info",
    );
  } catch {
    ctx.ui.notify("Couldn't reach free-pi to reset your session — check your connection.", "error");
  }
}

// ---- /whats-new -----------------------------------------------------------

/** Shows the bundled changelog highlights for the most recent versions. */
export function showWhatsNew(ctx: NotifyContext): void {
  const lines = CHANGELOG_HIGHLIGHTS.slice(0, 3).flatMap((e) => [
    `free-pi ${e.version}:`,
    ...e.highlights.map((h) => `  • ${h}`),
  ]);
  ctx.ui.notify(lines.join("\n"), "info");
}

// ---- /update --------------------------------------------------------------

export interface UpdateDeps {
  env?: Record<string, string | undefined>;
  /** Installs free-pi-cli@latest globally; injected in tests. */
  installLatest?: () => Promise<{ ok: boolean }>;
}

function isEphemeralNpx(env: Record<string, string | undefined>): boolean {
  return env.npm_command === "exec" || env.npm_lifecycle_event === "npx";
}

async function defaultInstallLatest(): Promise<{ ok: boolean }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    // shell on win32: npm is `npm.cmd`, a batch file. Node refuses to spawn a
    // .cmd without a shell (CVE-2024-27980 hardening), so this resolved
    // { ok: false } on every Windows /update. Same root cause as the
    // self-update spawn — the command is a fixed literal, no quoting surface.
    const child = spawn("npm", ["install", "-g", "free-pi-cli@latest"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve({ ok: false }));
    child.on("close", (code) => resolve({ ok: code === 0 }));
  });
}

/**
 * On-demand update. An npx run is always the latest by definition, so it's a
 * no-op there; a global install runs `npm install -g free-pi-cli@latest`.
 * Never throws.
 */
export async function runUpdate(ctx: NotifyContext, deps: UpdateDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (isEphemeralNpx(env)) {
    ctx.ui.notify("You're running via npx, which always fetches the latest — you're already up to date.", "info");
    return;
  }
  ctx.ui.notify("Updating free-pi-cli… (npm install -g free-pi-cli@latest)", "info");
  try {
    const { ok } = await (deps.installLatest ?? defaultInstallLatest)();
    ctx.ui.notify(
      ok
        ? "Updated — restart free-pi-cli to use the new version."
        : "Update failed. Try manually: npm install -g free-pi-cli@latest",
      ok ? "info" : "error",
    );
  } catch {
    ctx.ui.notify("Update failed. Try manually: npm install -g free-pi-cli@latest", "error");
  }
}

// ---- /buy-credits ---------------------------------------------------------

/**
 * Deliberate, discoverable "I want to buy" path (epic #221): same resolver as
 * the free_pi_buy_credits tool, but a slash command needs no model turn — it
 * works even when the user is out of usage and every completion is a 429.
 * Never throws.
 */
export async function buyCredits(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  const page = await resolveBuyPage(opts);
  if (page.kind === "error") return ctx.ui.notify(page.text, "error");
  if (page.kind === "unavailable") return ctx.ui.notify(BUY_NOT_AVAILABLE_TEXT, "info");
  (opts.openBrowserImpl ?? openBrowser)(page.url);
  ctx.ui.notify(buyPageText(page.url), "info");
}

// ---- /support ---------------------------------------------------------------

/**
 * Opens today's advertiser (the click URL of the currently-shown banner ad)
 * in the browser. KTD5/R10: no reward, no server call of its own — the only
 * server contact is the browser following the click redirect. Never throws.
 */
export async function openAdvertiser(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  const url = opts.getAdvertiserUrl?.();
  if (!url) {
    ctx.ui.notify("No advertiser loaded yet.", "info");
    return;
  }
  (opts.openBrowserImpl ?? openBrowser)(url);
  ctx.ui.notify("Opening today's advertiser in your browser. Thank you for supporting free-pi.", "info");
}

// ---- /tos / /privacy-policy -------------------------------------------------

export const TERMS_URL = "https://freepi.ai/terms";
export const PRIVACY_URL = "https://freepi.ai/privacy";

/** Opens the Terms of Service in the browser. Never throws. */
export async function openTos(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  (opts.openBrowserImpl ?? openBrowser)(TERMS_URL);
  ctx.ui.notify(`Opening the Terms of Service in your browser: ${TERMS_URL}`, "info");
}

/** Opens the Privacy Policy in the browser. Never throws. */
export async function openPrivacyPolicy(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  (opts.openBrowserImpl ?? openBrowser)(PRIVACY_URL);
  ctx.ui.notify(`Opening the Privacy Policy in your browser: ${PRIVACY_URL}`, "info");
}

// ---- /usage ---------------------------------------------------------------

/** Same output as the free_pi_usage tool, with no model turn — works at the wall. Never throws. */
export async function showUsage(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  const r = await fetchUsageText(opts);
  ctx.ui.notify(r.text, r.ok ? "info" : "error");
}

// ---- extension ------------------------------------------------------------

export function createFreePiCommandsExtension(opts: CreateCommandsOptions): InlineExtension {
  return {
    name: "free-pi-commands",
    factory(pi: ExtensionAPI) {
      pi.registerCommand("close-other-session", {
        description: "Clear your other running free-pi session (use if a previous one is stuck).",
        handler: (_args, ctx) => closeOtherSession(opts, ctx),
      });
      pi.registerCommand("whats-new", {
        description: "Show what's new in recent free-pi releases.",
        handler: async (_args, ctx) => showWhatsNew(ctx),
      });
      pi.registerCommand("update", {
        description: "Update free-pi-cli to the latest version.",
        handler: (_args, ctx) => runUpdate(ctx),
      });
      pi.registerCommand("usage", {
        description: "Show how much of today's free allowance you have used, and your purchased credit.",
        handler: (_args, ctx) => showUsage(opts, ctx),
      });
      pi.registerCommand("buy-credits", {
        description: "Buy more usage ($5 or $10 packs, card or USDC) — opens the buy page.",
        handler: (_args, ctx) => buyCredits(opts, ctx),
      });
      pi.registerCommand("support", {
        description: "Open today's advertiser in your browser to support free-pi.",
        handler: (_args, ctx) => openAdvertiser(opts, ctx),
      });
      pi.registerCommand("tos", {
        description: "Open the free-pi Terms of Service in your browser.",
        handler: (_args, ctx) => openTos(opts, ctx),
      });
      pi.registerCommand("privacy-policy", {
        description: "Open the free-pi Privacy Policy in your browser.",
        handler: (_args, ctx) => openPrivacyPolicy(opts, ctx),
      });
    },
  };
}
