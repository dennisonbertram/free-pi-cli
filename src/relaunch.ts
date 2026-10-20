// Required-update relaunch: when the server says this CLI is below its minimum
// version (typically a stale npx cache), re-run ourselves as
// `npx --yes free-pi-cli@<latest> <same args>` instead of telling the user to.
// The caller (run.ts) only invokes this for a REQUIRED update, before any ad,
// banner or model request; optional updates keep the notice / `/update` path.
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";

export interface RelaunchChild {
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

export interface RelaunchDeps {
  env: Record<string, string | undefined>;
  /** The user's original arguments (process.argv.slice(2)). */
  argv: readonly string[];
  platform: NodeJS.Platform;
  /** Config-file switch (cli-config `autoUpdate`). */
  autoUpdateEnabled: () => boolean;
  spawn: (
    cmd: string,
    args: string[],
    opts: { stdio: "inherit"; env: Record<string, string | undefined>; shell: boolean },
  ) => RelaunchChild;
  proc: { on(sig: NodeJS.Signals, cb: () => void): unknown; off(sig: NodeJS.Signals, cb: () => void): unknown };
  log: (message: string) => void;
}

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
// On Windows `npx.cmd` needs shell:true, and Node joins the args with plain
// spaces (no quoting). Only relaunch when every arg is non-empty and made of
// characters cmd.exe treats literally; anything else (spaces, !, (, ), CR/LF,
// quotes, & | < > % ^ ...) falls back to the manual message.
const WIN_SAFE_ARG = /^[A-Za-z0-9._:=\/@+,-]+$/;

/**
 * Returns the relaunched process's exit code, or undefined when no relaunch
 * happened or it failed before the CLI started (caller prints the manual
 * "update with: npx free-pi-cli@latest" message and exits non-zero).
 */
export async function relaunchViaNpx(latest: string | undefined, deps: RelaunchDeps): Promise<number | undefined> {
  const { env } = deps;
  if ("FREEPI_NO_AUTO_UPDATE" in env || !deps.autoUpdateEnabled()) return undefined;
  // Loop guard: we ARE the relaunched process and are still below minimum.
  if (env.FREEPI_AUTO_UPDATED) return undefined;

  const win = deps.platform === "win32";
  // A .cmd can only be spawned through a shell on Windows (Node's CVE-2024-27980
  // hardening), and the shell would interpret metacharacters in the user's args.
  if (win && !deps.argv.every((a) => WIN_SAFE_ARG.test(a))) return undefined;

  const target = latest && SEMVER.test(latest) ? latest : "latest";
  // The relaunched CLI touches this file as soon as it starts, so a non-zero
  // exit with no file means npx itself failed (offline, bad install) and we
  // should fall back to the manual message rather than pass that code on.
  const readyDir = mkdtempSync(join(tmpdir(), "free-pi-relaunch-"));
  const readyFile = join(readyDir, "started");

  try {
    deps.log(`Updating free-pi to ${target}…`);
    return await new Promise<number | undefined>((resolve) => {
      let child: RelaunchChild;
      try {
        child = deps.spawn(win ? "npx.cmd" : "npx", ["--yes", `free-pi-cli@${target}`, ...deps.argv], {
          stdio: "inherit",
          env: { ...env, FREEPI_AUTO_UPDATED: target, FREEPI_RELAUNCH_READY: readyFile },
          shell: win,
        });
      } catch {
        resolve(undefined);
        return;
      }
      // POSIX: the terminal already delivers Ctrl+C (SIGINT) to the whole
      // foreground group (us, npx, the CLI), so forwarding it would multiply it.
      // We only need a no-op handler so we outlive the child and can report its
      // status. SIGTERM/SIGHUP are sent to us alone, so those are forwarded.
      // Windows: the console delivers Ctrl+C to the whole group and child.kill()
      // would only hit the outer cmd.exe, so install nothing there.
      const handlers: Array<[NodeJS.Signals, () => void]> = win
        ? []
        : [
            ["SIGINT", () => {}],
            ["SIGTERM", () => void child.kill("SIGTERM")],
            ["SIGHUP", () => void child.kill("SIGHUP")],
          ];
      for (const [sig, cb] of handlers) deps.proc.on(sig, cb);
      const done = (code: number | undefined) => {
        for (const [sig, cb] of handlers) deps.proc.off(sig, cb);
        resolve(code);
      };
      child.on("error", () => done(undefined));
      child.on("exit", (code, signal) => {
        const exitCode = code ?? 128 + (signal ? (osConstants.signals[signal] ?? 0) : 0);
        // Cancelled (Ctrl+C / SIGTERM / SIGHUP) before the CLI started is not an
        // install failure: pass the status through, no manual-update message.
        const cancelled = signal === "SIGINT" || signal === "SIGTERM" || signal === "SIGHUP" || exitCode === 130 || exitCode === 143 || exitCode === 129;
        done(exitCode !== 0 && !cancelled && !existsSync(readyFile) ? undefined : exitCode);
      });
    });
  } finally {
    rmSync(readyDir, { recursive: true, force: true });
  }
}
