import { describe, expect, test } from "bun:test";
import pkg from "../package.json";
import { highlightsFor } from "../src/changelog";

describe("changelog", () => {
  test("highlightsFor returns entries for a known version, undefined for an unknown one", () => {
    expect((highlightsFor("0.2.6") ?? []).length).toBeGreaterThan(0);
    expect(highlightsFor("9.9.9")).toBeUndefined();
  });

  test("the changelog has an entry matching package.json version (bump + changelog stay in sync)", () => {
    const version = (pkg as { version: string }).version;
    expect((highlightsFor(version) ?? []).length).toBeGreaterThan(0);
  });
});
