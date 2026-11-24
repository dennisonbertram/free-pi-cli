import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAutoUpdate, readSpendBonusCredits, writeSpendBonusCredits } from "../src/cli-config";

function tempConfigPath(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "free-pi-cli-config-test-"));
  const path = join(dir, "config.json");
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
}

describe("readAutoUpdate (#37 R5) — fail-open to true, never throws", () => {
  test("absent file -> true", () => {
    const path = tempConfigPath(); // never written
    expect(readAutoUpdate(path)).toBe(true);
  });

  test("{autoUpdate:false} -> false", () => {
    expect(readAutoUpdate(tempConfigPath(JSON.stringify({ autoUpdate: false })))).toBe(false);
  });

  test("{autoUpdate:true} -> true", () => {
    expect(readAutoUpdate(tempConfigPath(JSON.stringify({ autoUpdate: true })))).toBe(true);
  });

  test("malformed JSON -> true", () => {
    expect(readAutoUpdate(tempConfigPath("not json{{{"))).toBe(true);
  });

  test("missing key -> true", () => {
    expect(readAutoUpdate(tempConfigPath(JSON.stringify({ somethingElse: 1 })))).toBe(true);
  });

  test("non-boolean value -> true (only strict `false` disables)", () => {
    expect(readAutoUpdate(tempConfigPath(JSON.stringify({ autoUpdate: "no" })))).toBe(true);
  });

  test("directory does not exist -> true, never throws", () => {
    const missing = join(tmpdir(), "free-pi-cli-config-test-does-not-exist", "config.json");
    expect(() => readAutoUpdate(missing)).not.toThrow();
    expect(readAutoUpdate(missing)).toBe(true);
  });
});

describe("readSpendBonusCredits (#23) — fail-closed to false, never throws", () => {
  test("absent file -> false (ask, the safe default)", () => {
    expect(readSpendBonusCredits(tempConfigPath())).toBe(false);
  });

  test("{spendBonusCredits:true} -> true", () => {
    expect(readSpendBonusCredits(tempConfigPath(JSON.stringify({ spendBonusCredits: true })))).toBe(true);
  });

  test("{spendBonusCredits:\"yes\"} -> false (only strict true opts in)", () => {
    expect(readSpendBonusCredits(tempConfigPath(JSON.stringify({ spendBonusCredits: "yes" })))).toBe(false);
  });

  test("malformed JSON -> false", () => {
    expect(readSpendBonusCredits(tempConfigPath("not json{{{"))).toBe(false);
  });

  test("missing file and nonexistent directory -> false, never throws", () => {
    const missing = join(tmpdir(), "free-pi-cli-config-test-does-not-exist", "config.json");
    expect(() => readSpendBonusCredits(missing)).not.toThrow();
    expect(readSpendBonusCredits(missing)).toBe(false);
  });
});

describe("writeSpendBonusCredits (#23) — creates, preserves, round-trips", () => {
  test("creates the directory and the file, and reads back", () => {
    const dir = mkdtempSync(join(tmpdir(), "free-pi-cli-config-write-"));
    const path = join(dir, "nested", "deeper", "config.json");
    expect(writeSpendBonusCredits(path, true)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readSpendBonusCredits(path)).toBe(true);
    // No temp file left behind.
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  test("preserves keys already in the file (autoUpdate) instead of overwriting them", () => {
    const path = tempConfigPath(JSON.stringify({ autoUpdate: false }));
    expect(writeSpendBonusCredits(path, true)).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ autoUpdate: false, spendBonusCredits: true });
    // The opt-out the user set is still honoured.
    expect(readAutoUpdate(path)).toBe(false);
  });

  test("round-trips: true then false, and readAutoUpdate still works afterward", () => {
    const path = tempConfigPath(JSON.stringify({ autoUpdate: false }));
    expect(writeSpendBonusCredits(path, true)).toBe(true);
    expect(writeSpendBonusCredits(path, false)).toBe(true);
    expect(readSpendBonusCredits(path)).toBe(false);
    expect(readAutoUpdate(path)).toBe(false);
  });

  test("malformed existing file -> replaced with a valid one, no throw", () => {
    const path = tempConfigPath("not json{{{");
    expect(writeSpendBonusCredits(path, true)).toBe(true);
    expect(readSpendBonusCredits(path)).toBe(true);
  });

  test("unwritable path -> false, never throws", () => {
    const path = join(tmpdir(), "free-pi-cli-config-test-\u0000bad", "config.json");
    expect(() => writeSpendBonusCredits(path, true)).not.toThrow();
    expect(writeSpendBonusCredits(path, true)).toBe(false);
  });
});
