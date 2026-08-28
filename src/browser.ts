import { spawn } from "node:child_process";

export interface OpenCommand {
  command: string;
  args: string[];
  /** Only ever set on win32 — see buildOpenCommand's comment. */
  windowsVerbatimArguments?: boolean;
}

/** cmd.exe metacharacters. `^` is the escape character, so it must come first. */
const CMD_METACHARACTERS = /[\^&|<>()]/g;

/**
 * Normalizes a URL for handing to a platform opener, or returns null if it is
 * not one we are willing to open.
 *
 * The URL reaches us from the server (`verification_uri` in the device-flow
 * response), and the wire schema types it as a bare string — so this is the
 * only place its shape is checked. Two gates:
 *   - it must parse, and its scheme must be http/https. A `file:` or custom
 *     scheme handed to `open`/`start` is a launch primitive, not a link.
 *   - the returned `href` is WHATWG-normalized, which percent-encodes spaces,
 *     quotes, `>` and `^`. It does NOT encode `|`, `(` or `)`, which is why
 *     the win32 branch below still escapes the full metacharacter set rather
 *     than trusting normalization alone.
 */
export function safeBrowserUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return parsed.href;
  } catch {
    return null;
  }
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
 * `cmd /c start "" <escaped-url>` with windowsVerbatimArguments so Node's
 * own arg quoting can't re-introduce bug 1.
 *
 * We escape every cmd metacharacter, not just `&`. windowsVerbatimArguments
 * means the string reaches cmd exactly as written, and the URL is
 * server-supplied, so a lone `|` would be a pipe and `>` a redirect. Callers
 * should pass a `safeBrowserUrl()` result; this escape is the second layer.
 */
export function buildOpenCommand(url: string, platform: NodeJS.Platform): OpenCommand {
  if (platform === "win32") {
    return {
      command: "cmd",
      args: ["/c", "start", '""', url.replace(CMD_METACHARACTERS, (char) => `^${char}`)],
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
    const safeUrl = safeBrowserUrl(url);
    // Nothing to open, and nothing to say: the URL was printed for the user
    // before we got here, which is the primary path anyway.
    if (safeUrl === null) return;
    const { command, args, windowsVerbatimArguments } = buildOpenCommand(safeUrl, platform);
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
