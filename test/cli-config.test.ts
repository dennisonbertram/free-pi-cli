import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAutoUpdate } from "../src/cli-config";

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
