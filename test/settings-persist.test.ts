import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { buildSettingsManager, type LaunchOptions } from "../src/pi-launch";
import { PROVIDER_NAME, SAFE_TOOLS, type CatalogModel } from "../src/provider";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const models: CatalogModel[] = [{ id: "test-model", name: "Test" }];

function launchOpts(agentDir: string): LaunchOptions {
  return { baseUrl: "http://stub", jwt: "jwt", agentDir, models };
}

function writeSettings(agentDir: string, settings: unknown) {
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings, null, 2));
}

// SettingsManager.save() writes through an async queue; give it a tick before relaunching.
const flush = () => Bun.sleep(20);

// The bug: Ctrl+S in pi's thinking selector persists through SettingsManager.save().
// An in-memory manager threw that write away, so the level was back to the default
// on the next launch.
describe("buildSettingsManager persistence", () => {
  test("a saved default thinking level survives a relaunch", async () => {
    const agentDir = tmp("free-pi-settings-agent-");
    buildSettingsManager(launchOpts(agentDir), models, true).setDefaultThinkingLevel("high");
    await flush();

    const next = buildSettingsManager(launchOpts(agentDir), models, true);
    expect(next.getDefaultThinkingLevel()).toBe("high");
  });

  test("a per-model thinking level survives a relaunch", async () => {
    const agentDir = tmp("free-pi-settings-agent-");
    buildSettingsManager(launchOpts(agentDir), models, true).setModelThinkingLevel(PROVIDER_NAME, "test-model", "low");
    await flush();

    expect(buildSettingsManager(launchOpts(agentDir), models, true).getModelThinkingLevel(PROVIDER_NAME, "test-model")).toBe("low");
  });

  test("free-pi pins still win over a hand-edited settings file", () => {
    const agentDir = tmp("free-pi-settings-agent-");
    writeSettings(agentDir, { packages: ["evil/pkg"], defaultProvider: "openai", defaultTools: ["bash"] });

    const settings = buildSettingsManager(launchOpts(agentDir), models, true).getSettings();
    expect(settings.packages).toEqual([]);
    expect(settings.defaultProvider).toBe(PROVIDER_NAME);
    expect(settings.defaultModel).toBe("test-model");
    expect(settings.defaultTools).toContain(SAFE_TOOLS[0]!);
  });

  test("a save keeps the user's own keys and pins the rest", async () => {
    const agentDir = tmp("free-pi-settings-agent-");
    writeSettings(agentDir, { defaultThinkingLevel: "low", packages: ["evil/pkg"] });
    buildSettingsManager(launchOpts(agentDir), models, true).setDefaultThinkingLevel("high");
    await flush();

    const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    expect(raw.defaultThinkingLevel).toBe("high");
    expect(raw.packages).toEqual([]);
  });
});
