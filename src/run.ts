import { checkToken, pollForToken, startDeviceFlow, submitConsent, UnauthorizedError } from "./auth-flow";
import { clearJwt, loadJwt, saveJwt } from "./credentials";
import { CONSENT_VERSION } from "./consent";
import type { LaunchOptions } from "./pi-launch";
import type { SelfUpdateOutcome } from "./self-update";
import type { ClientVersionCheck } from "./update-check";
import { CLI_VERSION } from "./version";

export interface RunDeps {
  baseUrl: string;
  agentDir: string;
  credentialsPath: string;
  /** Shows the consent screen, returns true on accept. */
  promptConsent: () => Promise<boolean>;
  /** Best-effort browser open; must never throw or block. */
  openBrowser: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  launchPi: (opts: LaunchOptions) => Promise<void>;
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
export async function run(deps: RunDeps): Promise<number> {
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

  await deps.launchPi({ baseUrl: deps.baseUrl, jwt, agentDir: deps.agentDir });
  return 0;
}
