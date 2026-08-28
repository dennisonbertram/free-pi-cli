import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maybeWhatsNew } from "../src/whats-new";
import { getLastSeenVersionPath } from "../src/paths";

function tmpAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "free-pi-wn-"));
}
function marker(dir: string): string {
  return readFileSync(getLastSeenVersionPath(dir), "utf-8").trim();
}

describe("maybeWhatsNew", () => {
  test("first run (no marker): seeds the marker, shows nothing", () => {
    const dir = tmpAgentDir();
    expect(maybeWhatsNew("0.2.6", dir)).toBeUndefined();
    expect(marker(dir)).toBe("0.2.6");
  });

  test("returning user who updated: shows the banner once, then not again", () => {
    const dir = tmpAgentDir();
    writeFileSync(getLastSeenVersionPath(dir), "0.2.5", "utf-8");

    const banner = maybeWhatsNew("0.2.6", dir);
    expect(banner).toContain("What's new in free-pi 0.2.6");
    expect(banner).toContain("/close-other-session");
    expect(marker(dir)).toBe("0.2.6");

    expect(maybeWhatsNew("0.2.6", dir)).toBeUndefined(); // shown once
  });

  test("same version as last seen: shows nothing", () => {
    const dir = tmpAgentDir();
    writeFileSync(getLastSeenVersionPath(dir), "0.2.6", "utf-8");
    expect(maybeWhatsNew("0.2.6", dir)).toBeUndefined();
  });

  test("downgrade (marker newer than running): shows nothing, marker set to running version", () => {
    const dir = tmpAgentDir();
    writeFileSync(getLastSeenVersionPath(dir), "0.3.0", "utf-8");
    expect(maybeWhatsNew("0.2.6", dir)).toBeUndefined();
    expect(marker(dir)).toBe("0.2.6");
  });

  test("updated to a version with no changelog entry: shows nothing, still advances the marker", () => {
    const dir = tmpAgentDir();
    writeFileSync(getLastSeenVersionPath(dir), "0.2.5", "utf-8");
    expect(maybeWhatsNew("0.2.98", dir)).toBeUndefined();
    expect(marker(dir)).toBe("0.2.98");
  });
});
