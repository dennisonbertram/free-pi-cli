import { homedir } from "node:os";
import { join } from "node:path";

// Fully separate from pi's own `~/.pi/agent` so an existing pi install (and
// its credentials/settings/sessions) is never touched by free-pi-cli.
const FREE_PI_DIR_NAME = ".free-pi";

export function getFreePiAgentDir(): string {
  return join(homedir(), FREE_PI_DIR_NAME, "agent");
}

export function getCredentialsPath(agentDir: string = getFreePiAgentDir()): string {
  return join(agentDir, "credentials.json");
}

/** #37 U1: the self-update opt-out config file, `~/.free-pi/config.json`. Read-only — never created. */
export function getConfigPath(): string {
  return join(homedir(), FREE_PI_DIR_NAME, "config.json");
}
