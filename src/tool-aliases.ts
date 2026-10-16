// Models sometimes call bash with `cmd` or read with `file`/`file_path`, which
// pi rejects as a validation error and costs a wasted turn. Re-register those
// two built-ins (same definitions, same names) with a prepareArguments that
// renames the alias when the real key is missing. Nothing else changes.
//
// cwd: the built-in tools run in `ctx.cwd || cwd` (pi bash.js:174, read.js:73),
// so the session's cwd wins; the process cwd is only pi's own fallback.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";

/** Rename the first present alias to `key`, only when `key` is absent. */
export function aliasArgs(input: unknown, key: string, aliases: string[]): unknown {
  if (!input || typeof input !== "object" || key in input) return input;
  const args = input as Record<string, unknown>;
  const alias = aliases.find((a) => a in args);
  if (!alias) return input;
  const { [alias]: value, ...rest } = args;
  return { ...rest, [key]: value };
}

/**
 * pi normalizes shellPath with normalizePath/normalizeWindowsShellPath
 * (pi-coding-agent dist/utils/paths.js, via SettingsManager.getShellPath).
 * They are not exported, so this repeats the behavior pi applies to shellPath:
 * Git Bash/MSYS/Cygwin/WSL drive paths on win32, ~ and ~/ (~\ on win32),
 * and file:// URLs. Pinned to pi 1.2.0.
 */
export function normalizeShellPath(
  input: string,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  let p = input;
  if (platform === "win32" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\")) {
    const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) p = `${m[1]!.toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) return join(home, p.slice(2));
  if (/^file:\/\//.test(p)) return fileURLToPath(p);
  return p;
}

export function createToolAliasesExtension(): InlineExtension {
  return {
    name: "free-pi-tool-aliases",
    factory: (pi: ExtensionAPI) => {
      const cwd = process.cwd();
      const bash = createBashToolDefinition(cwd);
      const read = createReadToolDefinition(cwd);
      // pi builds its own bash/read from session settings (agent-session.js
      // _buildRuntime). Settings are not readable while a factory loads
      // (getSettings throws until the runner binds it), so build the real tool
      // inside execute, from the settings at that moment.
      pi.registerTool({
        ...bash,
        prepareArguments: (a) => aliasArgs(bash.prepareArguments ? bash.prepareArguments(a) : a, "command", ["cmd"]) as never,
        execute: (...args) => {
          const s = pi.getSettings();
          const shellPath = s.shellPath ? normalizeShellPath(s.shellPath) : s.shellPath;
          return createBashToolDefinition(cwd, { commandPrefix: s.shellCommandPrefix, shellPath }).execute(...args);
        },
      });
      pi.registerTool({
        ...read,
        prepareArguments: (a) =>
          aliasArgs(read.prepareArguments ? read.prepareArguments(a) : a, "path", ["file", "file_path"]) as never,
        execute: (...args) =>
          createReadToolDefinition(cwd, { autoResizeImages: pi.getSettings().images?.autoResize ?? true }).execute(...args),
      });
    },
  };
}
