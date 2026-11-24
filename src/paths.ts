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

/** 0.2.6: the last CLI version whose "what's new" the user has already seen. */
export function getLastSeenVersionPath(agentDir: string = getFreePiAgentDir()): string {
  return join(agentDir, "last-seen-version");
}

/**
 * #37 U1 / #23: the config file, `~/.free-pi/config.json` — self-update opt-out
 * (`autoUpdate`) and the bonus-credit mode (`spendBonusCredits`). The CLI now
 * writes it (/spend-bonus-credits, the gate's "don't ask again"); self-update
 * still never creates it on its own.
 */
export function getConfigPath(): string {
  return join(homedir(), FREE_PI_DIR_NAME, "config.json");
}
