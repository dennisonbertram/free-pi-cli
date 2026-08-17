// #37 U1 / R5: read-only opt-out config. Never creates or writes the file —
// the default (autoUpdate on) needs no state on disk, only an owner-set
// `{"autoUpdate":false}` does. Fails open to `true` on any read/parse error
// so a broken config file can never silently disable the version check's
// safety net.
import { readFileSync } from "node:fs";

export function readAutoUpdate(configPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    const autoUpdate = (parsed as { autoUpdate?: unknown } | null)?.autoUpdate;
    return autoUpdate !== false;
  } catch {
    return true;
  }
}
