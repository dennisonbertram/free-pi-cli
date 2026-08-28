// #37 U1: in-place self-update. No re-exec (Node has no execve) — a
// successful update lands on disk and applies next launch, exactly like
// Claude Code / gemini-cli (see docs/research/37-cli-self-update-mechanics.md).
// Every gate and every failure mode falls back to phase-1 behavior
// (`fallback`) rather than throwing — this function must never crash or
// block CLI startup, and must never run a real npm command outside of the
// injected `spawn` (R7: fully unit-testable with zero real npm calls).
import path from "node:path";

export type SelfUpdateOutcome = "updated-continue" | "updated-exit" | "notice" | "blocked";

export interface SpawnResult {
  status: number | null;
  stdout: string;
  error?: Error;
}

export interface SelfUpdateDeps {
  env: Record<string, string | undefined>;
  autoUpdateEnabled: () => boolean;
  spawn: (cmd: string, args: string[], opts: { timeout: number }) => SpawnResult;
  cliRealpath: string;
  log: (message: string) => void;
}

const NPM_ROOT_TIMEOUT_MS = 10_000;
const NPM_INSTALL_TIMEOUT_MS = 60_000;

export async function maybeSelfUpdate(
  action: "notice" | "block",
  latest: string | undefined,
  deps: SelfUpdateDeps,
): Promise<SelfUpdateOutcome> {
  const fallback = (): SelfUpdateOutcome => (action === "notice" ? "notice" : "blocked");

  try {
    // Gate (a): enabled — config default-true, env is a one-off override.
    if ("FREEPI_NO_AUTO_UPDATE" in deps.env || !deps.autoUpdateEnabled()) return fallback();

    // Gate (b): not an ephemeral npx/dlx run (already the latest by definition).
    if (deps.env.npm_config_user_agent || deps.env.npm_lifecycle_event === "npx") return fallback();

    // Gate (c): updatable global npm install, path-boundary-checked (not a
    // raw string prefix — a sibling dir like "node_modules-evil" must not match).
    const root = deps.spawn("npm", ["root", "-g"], { timeout: NPM_ROOT_TIMEOUT_MS });
    if (root.error || root.status !== 0) return fallback();
    const globalRoot = root.stdout.trim();
    const isGlobalInstall =
      deps.cliRealpath === globalRoot || deps.cliRealpath.startsWith(globalRoot + path.sep);
    if (!isGlobalInstall) return fallback();

    const install = deps.spawn("npm", ["install", "-g", "free-pi-cli@latest"], {
      timeout: NPM_INSTALL_TIMEOUT_MS,
    });
    if (install.error || install.status !== 0) return fallback();

    if (action === "notice") {
      deps.log(`updated to ${latest}; applies next launch`);
      return "updated-continue";
    }
    deps.log(`updated to ${latest} — re-run free-pi-cli`);
    return "updated-exit";
  } catch {
    return fallback();
  }
}
