import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildRuntimeOptions, SKILLS_DIR } from "../src/pi-launch";

describe("bundled long-jobs skill", () => {
  const file = join(SKILLS_DIR, "long-jobs", "SKILL.md");

  test("is wired as an additional skill path and the file exists", () => {
    const opts = buildRuntimeOptions(
      { baseUrl: "http://example.test", jwt: "t", agentDir: mkdtempSync(join(tmpdir(), "free-pi-skill-")) },
      "s",
    );
    expect(opts.resourceLoaderOptions.additionalSkillPaths).toEqual([SKILLS_DIR]);
    expect(existsSync(file)).toBe(true);
  });

  test("frontmatter has name and a description under 1024 chars", () => {
    const fm = readFileSync(file, "utf8").replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/)![1]!;
    expect(fm).toMatch(/^name: long-jobs$/m);
    const desc = fm.match(/^description: (.+)$/m)![1]!;
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.length).toBeLessThan(1024);
  });

  test("the wait recipe ends when the marker appears (no tail -f | grep)", () => {
    const body = readFileSync(file, "utf8");
    expect(body).not.toMatch(/timeout \d+ tail -f/);
    expect(body).toContain("until grep -q");
  });
});
