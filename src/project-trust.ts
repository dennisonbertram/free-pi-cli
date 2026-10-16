// Decide, before the TUI starts, whether free-pi may load the current folder's
// project resources (.pi/mcp.json MCP servers, .pi/extensions, .pi/settings.json,
// .agents/skills ...). They can run code, so a cloned repo must not get that
// by default. pi's own CLI does the same check; the SDK path does not, and
// SettingsManager defaults to "trusted" unless told otherwise.
//
// The answer is saved in pi's ProjectTrustStore under free-pi's agent dir,
// the same store `free-pi-cli mcp` reads, so "start free-pi-cli in the project
// to trust it" is true.
import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

export const PROJECT_TRUST_PROMPT =
  "This folder has project settings for free-pi (.pi/ or .agents/skills), which can run code such as MCP servers and extensions. Trust this folder? [y/N] ";

export interface ProjectTrustDeps {
  hasTrustRequiringResources?: (cwd: string) => boolean;
  stdinIsTTY: boolean;
  log: (message: string) => void;
  askLine: (prompt: string) => Promise<string>;
}

export async function decideProjectTrust(cwd: string, agentDir: string, deps: ProjectTrustDeps): Promise<boolean> {
  if (!(deps.hasTrustRequiringResources ?? hasTrustRequiringProjectResources)(cwd)) return true;
  const store = new ProjectTrustStore(agentDir);
  const saved = store.get(cwd);
  if (typeof saved === "boolean") return saved;
  if (!deps.stdinIsTTY) {
    deps.log("This folder has project settings (.pi/ or .agents/skills); they are ignored because it is not trusted.");
    return false;
  }
  const decision = /^y(es)?$/i.test((await deps.askLine(PROJECT_TRUST_PROMPT)).trim());
  store.set(cwd, decision);
  return decision;
}

export function decideProjectTrustInteractive(cwd: string, agentDir: string): Promise<boolean> {
  return decideProjectTrust(cwd, agentDir, {
    stdinIsTTY: process.stdin.isTTY === true,
    log: (message) => console.log(message),
    askLine: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  });
}

/**
 * Trust for a runtime's folder. pi rebuilds the runtime with the target
 * session's cwd on /resume, /new, /fork, /import and /tree, so trust must be
 * decided per folder, not once per launch. The launch folder keeps the answer
 * it was asked for. Any other folder is never prompted (the TUI owns the
 * terminal): trusted only when it has nothing to protect or a saved yes.
 */
export function projectTrustForCwd(
  cwd: string,
  launch: { cwd: string; trusted: boolean },
  agentDir: string,
  hasTrustRequiringResources: (cwd: string) => boolean = hasTrustRequiringProjectResources,
): boolean {
  if (resolve(cwd) === resolve(launch.cwd)) return launch.trusted;
  if (!hasTrustRequiringResources(cwd)) return true;
  return new ProjectTrustStore(agentDir).get(cwd) === true;
}
