import { describe, expect, test } from "bun:test";
import { zstdSupportError } from "../src/node-check";

// Pure function — zlib module + version are injected, so these assertions never
// depend on the test runtime's own zstd support.
describe("zstdSupportError", () => {
  test("returns null when the runtime has zstd (createZstdDecompress present)", () => {
    expect(zstdSupportError({ createZstdDecompress: () => ({}) }, "22.19.0")).toBeNull();
    expect(zstdSupportError({ createZstdDecompress: () => ({}) }, "24.0.0")).toBeNull();
  });

  test("returns a friendly, actionable error when zstd is missing (old Node)", () => {
    const err = zstdSupportError({}, "20.11.1");
    expect(err).not.toBeNull();
    expect(err).toContain("Node 20.11.1"); // names the user's actual version
    expect(err).toContain("zstd");
    expect(err).toContain("nvm install 22"); // actionable next step
  });

  test("catches the 23.0-23.7 gap a >=22.19.0 semver check would miss", () => {
    // Node 23.5 satisfies engines ">=22.19.0" but lacks createZstdDecompress -> crashes.
    expect(zstdSupportError({}, "23.5.0")).not.toBeNull();
  });

  test("a non-function createZstdDecompress is still treated as unsupported", () => {
    expect(zstdSupportError({ createZstdDecompress: undefined }, "22.0.0")).not.toBeNull();
  });
});
