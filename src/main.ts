import { spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openBrowser } from "./browser";
import { HELP_TEXT, parseCliArgs, versionLine } from "./cli-args";
import { readAutoUpdate } from "./cli-config";
import { clearJwt, loadJwt } from "./credentials";
import { resolveBaseUrl } from "./env";
import { runLogout } from "./logout";
import { runFreePiMcp } from "./mcp-command";
import { getConfigPath, getCredentialsPath, getFreePiAgentDir } from "./paths";
import { startGravityPixel } from "./gravity-pixel";
import { launchPi } from "./pi-launch";
import { promptConsentInteractive } from "./prompt";
import { createRealSpawn } from "./real-spawn";
import { relaunchViaNpx } from "./relaunch";
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
  // Handshake for a parent that relaunched us after a required update: proves
  // the CLI actually started (see relaunch.ts). Best-effort, never fatal.
  if (process.env.FREEPI_RELAUNCH_READY) {
    try {
      writeFileSync(process.env.FREEPI_RELAUNCH_READY, "");
    } catch {}
  }

  // Local commands dispatch before run(): none of these contact the server,
  // so the consent/privacy invariants of the run() flow are never in play.
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === "version") {
    console.log(versionLine());
    process.exit(0);
  }
  if (command.kind === "help") {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (command.kind === "unknown") {
    console.error(`free-pi-cli: unknown argument "${command.arg}"\n\n${HELP_TEXT}`);
    process.exit(2);
  }
  if (command.kind === "logout") {
    const logoutCode = await runLogout({
      credentialsPath: getCredentialsPath(),
      loadJwt,
      clearJwt,
      log: (message) => console.log(message),
    });
    process.exit(logoutCode);
  }

  if (command.kind === "mcp") {
    const mcpCode = await runFreePiMcp(command.args, {
      cwd: process.cwd(),
      agentDir: getFreePiAgentDir(),
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    });
    process.exit(mcpCode);
  }

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
    startGravityPixel: (jwt) => startGravityPixel(jwt, join(dirname(agentDir), "gravity")),
    relaunchLatest: (latest) =>
      relaunchViaNpx(latest, {
        env: process.env,
        argv: process.argv.slice(2),
        platform: process.platform,
        autoUpdateEnabled: () => readAutoUpdate(getConfigPath()),
        spawn: (cmd, args, opts) => spawn(cmd, args, opts),
        proc: process,
        log: (message) => console.log(message),
      }),
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
