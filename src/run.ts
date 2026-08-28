import { checkToken, pollForToken, startDeviceFlow, submitConsent, UnauthorizedError } from "./auth-flow";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { clearJwt, loadJwt, saveJwt } from "./credentials";
import { CONSENT_VERSION } from "./consent";
import { showIntro } from "./onboarding";
import type { LaunchOptions } from "./pi-launch";
import type { SelfUpdateOutcome } from "./self-update";
import type { ClientVersionCheck } from "./update-check";
import { CLI_VERSION } from "./version";
import { maybeWhatsNew } from "./whats-new";

export interface RunDeps {
  baseUrl: string;
  agentDir: string;
  credentialsPath: string;
  /** Shows the consent screen, returns true on accept. */
  promptConsent: () => Promise<boolean>;
  /** Best-effort browser open; must never throw or block. */
  openBrowser: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  launchPi: (opts: LaunchOptions) => Promise<string | void>;
  log: (message: string) => void;
  /**
   * Startup update check (#37 R5). Injectable so tests can stub it, mirroring
   * `launchPi`. Called only after the consent gate below has resolved — see
   * `run()`'s comment for why the ordering matters.
   */
  checkClientVersion: (baseUrl: string, cliVersion: string) => Promise<ClientVersionCheck>;
  /**
   * #37 U1: in-place self-update, tried when checkClientVersion reports
   * "notice" or "block". Injectable (like checkClientVersion) so every gate
   * is unit-tested with zero real npm calls — see self-update.ts.
   */
  maybeSelfUpdate: (action: "notice" | "block", latest: string | undefined) => Promise<SelfUpdateOutcome>;
}

/** Runs the full device-flow login (device code -> consent -> poll), stores the JWT. */
async function loginFlow(deps: RunDeps): Promise<string> {
  const device = await startDeviceFlow(deps.baseUrl);
  deps.log(`\nOpen ${device.verification_uri} and enter code: ${device.user_code}\n`);
  deps.openBrowser(device.verification_uri);

  await submitConsent(deps.baseUrl, device.session_id, CONSENT_VERSION);

  const token = await pollForToken(deps.baseUrl, device.session_id, device.interval, deps.sleep);
  await saveJwt(deps.credentialsPath, token);
  return token;
}

/** Orchestrates first-run consent, login, token validation, and pi launch. Returns the process exit code. */
function parseSessionArg(argv: readonly string[]): { session?: string; error?: string } {
  const flagIndex = argv.indexOf("--session");
  if (flagIndex === -1) return {};

  const value = argv[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    return { error: "Missing value for --session" };
  }

  try {
    // The public SDK entry point does not re-export assertValidSessionId in
    // 0.84.2, but SessionManager's public constructor invokes that exact SDK
    // validator. In-memory keeps this validation side-effect free.
    SessionManager.inMemory(process.cwd(), { id: value });
  } catch (err) {
    return { error: `Invalid --session value: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { session: value };
}

export async function run(deps: RunDeps, argv: readonly string[] = process.argv): Promise<number> {
  const sessionArg = parseSessionArg(argv);
  if (sessionArg.error) {
    deps.log(sessionArg.error);
    return 1;
  }

  let jwt = await loadJwt(deps.credentialsPath);

  if (jwt) {
    try {
      await checkToken(deps.baseUrl, jwt);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        await clearJwt(deps.credentialsPath);
        jwt = null;
      }
      // Non-401 errors (network blip, 5xx) are not our cue to re-login;
      // fall through and let pi surface the real problem on first use.
    }
  }

  if (!jwt) {
    const accepted = await deps.promptConsent();
    if (!accepted) {
      deps.log("Declined. Exiting without contacting the free-pi server.");
      return 1;
    }
    // #63: first-run onboarding — shown here (first-run only) above the
    // device-login instructions the user must read, so it survives the pi TUI
    // taking over the screen. Returning users (JWT on disk) skip this branch.
    showIntro(deps.log);
    jwt = await loginFlow(deps);
  }

  // #37 R5 (privacy invariant): this must run only here — past the decline
  // early-return above — so a declined first-run still makes ZERO server
  // calls. By this point either a JWT already existed on disk (past consent)
  // or consent was just accepted and loginFlow() just ran, so a version
  // check is always warranted.
  const versionCheck = await deps.checkClientVersion(deps.baseUrl, CLI_VERSION);
  if (versionCheck.action !== "ok") {
    // #37 U1: try an in-place self-update first; only fall back to the
    // phase-1 notice/hard-stop text when self-update itself falls back.
    const outcome = await deps.maybeSelfUpdate(versionCheck.action, versionCheck.latest);
    if (outcome === "updated-exit") return 0;
    if (outcome === "blocked") {
      deps.log("free-pi-cli is below the required minimum version; update with: npx free-pi-cli@latest");
      return 1;
    }
    if (outcome === "notice") {
      deps.log(
        `update available: ${versionCheck.latest}, you have ${CLI_VERSION}; run \`npx free-pi-cli@latest\``,
      );
    }
    // "updated-continue": self-update already logged its own line; proceed.
  }

  // 0.2.6: after an update, show what changed once (terminal-only, never enters
  // model context). Best-effort; a bad state file returns undefined, not a throw.
  const whatsNew = maybeWhatsNew(CLI_VERSION, deps.agentDir);
  if (whatsNew) deps.log(whatsNew);

  // Server-driven one-line notice (e.g. a data-handling disclosure during a
  // free-model trial). Printed to the terminal only — it never touches the
  // completion messages, so it cannot enter model context (same UI-only
  // guarantee the ad sandbox enforces).
  if (versionCheck.notice) deps.log(versionCheck.notice);

  const finalSessionId = await deps.launchPi({
    baseUrl: deps.baseUrl,
    jwt,
    agentDir: deps.agentDir,
    session: sessionArg.session,
    model: versionCheck.model,
    models: versionCheck.models,
  });

  // First user feedback (2026-08-17): after closing the terminal, users didn't
  // know how to relaunch. The pi TUI's own exit line says `pi --session <id>`,
  // but our users installed `free-pi-cli` (via npx), not `pi`.
  deps.log(
    finalSessionId
      ? `\nfree-pi session ended. Start it again anytime:  npx free-pi-cli --session ${finalSessionId}`
      : "\nfree-pi session ended. Start it again anytime:  npx free-pi-cli",
  );
  deps.log("(or install once for a shorter command:  npm i -g free-pi-cli  →  free-pi-cli)\n");
  return 0;
}
