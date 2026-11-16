import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

type Storage = Parameters<typeof SettingsManager.fromStorage>[0];

/**
 * pi's own settings file (`<agentDir>/settings.json`) with free-pi's pins as the
 * baseline underneath it. pi's save() writes only the fields a session changed,
 * so a user's "set as default" (Ctrl+S in the thinking selector, /model, /theme)
 * survives the next run, while the pins still win on every load.
 *
 * The pins must live in the *global* settings rather than in
 * SettingsManager.applyOverrides(): pi's package manager reads packages from
 * getGlobalSettings(), so an override would let a settings file re-enable
 * packages the distro does not ship.
 *
 * Project settings are never read or written — free-pi's tool, extension and
 * package surface is fixed. The projectTrusted flag is still passed to pi, so
 * its own trust checks keep reporting what the launch decided.
 */
export function pinnedSettingsStorage(
  file: string,
  pins: Record<string, unknown>,
): Storage {
  const read = (): Record<string, unknown> => {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
    } catch {
      // Unparseable file: keep the pins instead of losing them to a syntax error.
      return {};
    }
  };
  return {
    withLock(scope, fn) {
      if (scope === "project") return;
      const next = fn(JSON.stringify({ ...read(), ...pins }, null, 2));
      if (next === undefined) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, next, "utf-8");
    },
  };
}
