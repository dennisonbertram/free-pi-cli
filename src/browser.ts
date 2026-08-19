import { spawn } from "node:child_process";

export interface OpenCommand {
  command: string;
  args: string[];
  /** Only ever set on win32 — see buildOpenCommand's comment. */
  windowsVerbatimArguments?: boolean;
}

/**
 * Pure builder for the platform open command — extracted from openBrowser()
 * as a test seam, mirroring the buildRuntimeOptions/launchPi split.
 *
 * win32 is the subtle one. `start` is a cmd.exe builtin, not an executable,
 * so it must run via `cmd /c` — and the previous
 * `spawn("start", [url], { shell: true })` form had two live bugs:
 *   1. `start` treats its first *quoted* argument as a window title. When
 *      the shell layer quoted the URL, `start "<url>"` opened an empty
 *      console window titled with the URL and no browser. The canonical fix
 *      is an explicit empty title: `start "" <url>`.
 *   2. cmd metacharacters split the line: a `&` in a query string (device
 *      verification URIs can carry one) truncates the URL and runs the rest
 *      as a second command. `^&` defers the `&` past cmd's parser.
 * Both fixes follow the long-standing opn/open package recipe:
 * `cmd /c start "" <url-with-^&>` with windowsVerbatimArguments so Node's
 * own arg quoting can't re-introduce bug 1.
 */
export function buildOpenCommand(url: string, platform: NodeJS.Platform): OpenCommand {
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", '""', url.replace(/&/g, "^&")],
      windowsVerbatimArguments: true,
    };
  }
  return { command: platform === "darwin" ? "open" : "xdg-open", args: [url] };
}

/**
 * Best-effort browser open. Printing the URL/code is the primary path (SSH
 * sessions and containers have no browser), so failures here are swallowed.
 */
export function openBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnImpl: typeof spawn = spawn,
): void {
  try {
    const { command, args, windowsVerbatimArguments } = buildOpenCommand(url, platform);
    const child = spawnImpl(command, args, {
      stdio: "ignore",
      detached: true,
      windowsVerbatimArguments,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore — the printed URL/code is sufficient
  }
}
