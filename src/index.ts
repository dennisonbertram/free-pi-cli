import { realpathSync } from "node:fs";
import { openBrowser } from "./browser";
import { readAutoUpdate } from "./cli-config";
import { resolveBaseUrl } from "./env";
import { getConfigPath, getCredentialsPath, getFreePiAgentDir } from "./paths";
import { launchPi } from "./pi-launch";
import { promptConsentInteractive } from "./prompt";
import { createRealSpawn } from "./real-spawn";
import { run } from "./run";
import { maybeSelfUpdate } from "./self-update";
import { checkClientVersion } from "./update-check";

/** Resolves symlinks (npm's global bin shim) so the path-boundary check in self-update.ts is meaningful. */
function resolveCliRealpath(): string {
  try {
    return realpathSync(process.argv[1] ?? "");
  } catch {
    // Fail safe: an empty string never matches (or prefixes) a real `npm root -g` path.
    return "";
  }
}

async function main(): Promise<void> {
  const agentDir = getFreePiAgentDir();
  const code = await run({
    baseUrl: resolveBaseUrl(),
    agentDir,
    credentialsPath: getCredentialsPath(agentDir),
    promptConsent: promptConsentInteractive,
    openBrowser,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    launchPi,
    log: (message) => console.log(message),
    checkClientVersion,
    maybeSelfUpdate: (action, latest) =>
      maybeSelfUpdate(action, latest, {
        env: process.env,
        autoUpdateEnabled: () => readAutoUpdate(getConfigPath()),
        spawn: createRealSpawn(),
        cliRealpath: resolveCliRealpath(),
        log: (message) => console.log(message),
      }),
  });
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
