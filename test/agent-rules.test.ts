import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_RULES } from "../src/agent-rules";
import { buildRuntimeOptions } from "../src/pi-launch";

describe("always-on agent rules", () => {
  test("the append override keeps base entries and adds AGENT_RULES last", () => {
    const opts = buildRuntimeOptions(
      { baseUrl: "http://example.test", jwt: "t", agentDir: mkdtempSync(join(tmpdir(), "free-pi-rules-")) },
      "s",
    );
    const override = opts.resourceLoaderOptions.appendSystemPromptOverride;
    expect(override).toBeDefined();
    expect(override!(["a", "b"])).toEqual(["a", "b", AGENT_RULES]);
    // appendSystemPrompt would disable user APPEND_SYSTEM.md discovery.
    expect("appendSystemPrompt" in opts.resourceLoaderOptions).toBe(false);
  });
});
