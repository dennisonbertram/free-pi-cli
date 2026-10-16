// `free-pi-cli mcp add|remove|list|login|logout`: pi's own `pi mcp` command,
// pointed at free-pi's agent directory (~/.free-pi/agent/mcp.json) and
// rebranded. Purely local, like logout: it reads and writes mcp.json and talks
// only to the MCP servers the user names, never to the free-pi server.
//
// pi keeps the implementation in dist/extensions/mcp/cli.js. That file is not
// in the package `exports` map, so a bare specifier cannot reach it; the map
// does not apply to a file URL, so we resolve the package entry
// (dist/index.js) and import the file beside it. pi is pinned to an exact
// version, and mcp-command.test.ts fails if a pi upgrade moves the file.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type RunMcpCommand = (
  args: string[],
  options: { cwd: string; agentDir: string; log: (line: string) => void; error: (line: string) => void },
) => Promise<number>;

export interface McpCommandDeps {
  cwd: string;
  agentDir: string;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Test seam: load pi's runMcpCommand from somewhere else. */
  loadRunner?: () => Promise<RunMcpCommand>;
}

/** Where pi's `mcp` command module lives, beside the package entry. */
export function piMcpCliPath(): string {
  return join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "extensions", "mcp", "cli.js");
}

async function loadPiRunner(): Promise<RunMcpCommand> {
  const path = piMcpCliPath();
  if (!existsSync(path)) {
    throw new Error(`free-pi-cli mcp is unavailable: the bundled pi package has no ${path}. Reinstall free-pi-cli.`);
  }
  const mod = (await import(pathToFileURL(path).href)) as { runMcpCommand?: RunMcpCommand };
  if (typeof mod.runMcpCommand !== "function") {
    throw new Error(`free-pi-cli mcp is unavailable: ${path} does not export runMcpCommand. Reinstall free-pi-cli.`);
  }
  return mod.runMcpCommand;
}

/**
 * pi prints `pi mcp ...` (APP_NAME), `~/.pi/agent/mcp.json` and "Start pi in
 * the project" — none of which a free-pi-cli user has. Project-level `.pi/mcp.json`
 * is a real path and stays. Chalk only wraps whole phrases, so plain text
 * matching is enough.
 */
export function brandMcpLine(line: string): string {
  return line
    .replace(/\bpi (?=mcp\b)/g, "free-pi-cli ")
    .replace(/~\/\.pi\/agent\b/g, "~/.free-pi/agent")
    .replace(/\b([Ss]tart) pi\b/g, "$1 free-pi-cli");
}

/** Runs the command and returns its exit code. Never throws. */
export async function runFreePiMcp(args: string[], deps: McpCommandDeps): Promise<number> {
  try {
    const run = await (deps.loadRunner ?? loadPiRunner)();
    // pi's default OAuth store and log read the agent dir through this env var.
    process.env.PI_CODING_AGENT_DIR = deps.agentDir;
    return await run(args, {
      cwd: deps.cwd,
      agentDir: deps.agentDir,
      log: (line) => deps.log(brandMcpLine(line)),
      error: (line) => deps.error(brandMcpLine(line)),
    });
  } catch (err) {
    deps.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
