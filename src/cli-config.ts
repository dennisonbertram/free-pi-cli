// #37 U1 / R5: the opt-out config, `~/.free-pi/config.json`. `autoUpdate` is
// read-only — the default (on) needs no state on disk, only an owner-set
// `{"autoUpdate":false}` does, and the version check never creates the file.
//
// #23 adds `spendBonusCredits`, the one key the CLI itself writes (the
// /spend-bonus-credits command and the gate's "don't ask again" option). Its
// safe default is "ask", i.e. false, so an absent file still needs no state
// and a missing/malformed file reads back as false. Each key fails in its own
// safe direction: `autoUpdate` fails open to `true` so a broken file can never
// silently disable the version check's safety net; `spendBonusCredits` fails
// closed to `false` so a broken file can never silently spend the user's
// credits.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function readAutoUpdate(configPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    const autoUpdate = (parsed as { autoUpdate?: unknown } | null)?.autoUpdate;
    return autoUpdate !== false;
  } catch {
    return true;
  }
}

/**
 * #23: true only for a strict `true`. Missing file, malformed JSON, a wrong
 * type — all read back as false ("ask"), the safe default.
 */
export function readSpendBonusCredits(configPath: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    const value = (parsed as { spendBonusCredits?: unknown } | null)?.spendBonusCredits;
    return value === true;
  } catch {
    return false;
  }
}

/** #23: the two states, named once so the gate, /usage and the command agree. */
export type BonusCreditMode = "ask" | "auto";

/** How each state is printed after "state:" in /usage and in the command's own notice. */
export const BONUS_MODE_STATE_LABEL: Record<BonusCreditMode, string> = {
  ask: "ask before using",
  auto: "use automatically",
};

/** #23: the mode, read the same way everywhere (absent/broken file = ask). */
export function readBonusCreditMode(configPath: string): BonusCreditMode {
  return readSpendBonusCredits(configPath) ? "auto" : "ask";
}

/**
 * #23: persists `spendBonusCredits`, creating the directory and file when
 * absent. Keys already in the file (notably `autoUpdate`) are preserved — this
 * is the same config.json the self-update opt-out lives in, so overwriting the
 * whole object would silently turn self-update back on. Writes through a
 * sibling temp file and a rename so a crash mid-write cannot truncate the
 * file. Returns false on any failure and never throws: a setting that could
 * not be saved must not end the user's turn.
 */
export function writeSpendBonusCredits(configPath: string, value: boolean): boolean {
  let existing: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
    // Only a JSON object can carry keys forward; null/array/scalar is treated
    // as a file with nothing worth preserving.
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // Missing or malformed: start from a fresh object.
  }
  const tmpPath = `${configPath}.tmp`;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify({ ...existing, spendBonusCredits: value }, null, 2)}\n`);
    renameSync(tmpPath, configPath);
    return true;
  } catch {
    return false;
  }
}
