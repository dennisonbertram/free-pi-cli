import { spawn } from "node:child_process";

/**
 * Best-effort browser open. Printing the URL/code is the primary path (SSH
 * sessions and containers have no browser), so failures here are swallowed.
 */
export function openBrowser(url: string): void {
  try {
    const command =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    const child = spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // ignore — the printed URL/code is sufficient
  }
}
