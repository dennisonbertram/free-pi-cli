import { describe, expect, test } from "bun:test";
import { CONSENT_TEXT, CONSENT_VERSION, NON_INTERACTIVE_CONSENT_TEXT, parseConsentAnswer } from "../src/consent";
import { promptConsent, type ConsentPromptDeps } from "../src/prompt";

function recorder(overrides: Partial<ConsentPromptDeps> = {}) {
  const logs: string[] = [];
  let asked = 0;
  const deps: ConsentPromptDeps = {
    stdinIsTTY: true,
    log: (m) => logs.push(m),
    askLine: async () => {
      asked++;
      return "y";
    },
    ...overrides,
  };
  return { deps, logs, asked: () => asked };
}

describe("promptConsent — non-TTY stdin declines instead of hanging", () => {
  test("stdin not a TTY -> false, readline never touched (its question promise never settles on piped EOF)", async () => {
    const { deps, logs, asked } = recorder({ stdinIsTTY: false });
    expect(await promptConsent(deps)).toBe(false);
    expect(asked()).toBe(0);
    // The one message explains what to do; the full consent screen is not
    // dumped into a log nobody can answer.
    expect(logs).toEqual([NON_INTERACTIVE_CONSENT_TEXT]);
  });

  test("the non-TTY message tells the user the interactive way forward", () => {
    expect(NON_INTERACTIVE_CONSENT_TEXT).toContain("npx free-pi-cli");
    expect(NON_INTERACTIVE_CONSENT_TEXT).toContain("terminal");
  });
});

describe("promptConsent — interactive path unchanged", () => {
  test("shows the consent screen, then the answer decides: y -> true", async () => {
    const { deps, logs } = recorder({ askLine: async () => "y" });
    expect(await promptConsent(deps)).toBe(true);
    expect(logs).toEqual([CONSENT_TEXT]);
  });

  test("n -> false; empty (just Enter) -> false — decline stays the default", async () => {
    expect(await promptConsent(recorder({ askLine: async () => "n" }).deps)).toBe(false);
    expect(await promptConsent(recorder({ askLine: async () => "" }).deps)).toBe(false);
  });
});

describe("CONSENT_VERSION and CONSENT_TEXT (v2: training + no-opt-out + legal links)", () => {
  test("version is 2", () => {
    expect(CONSENT_VERSION).toBe("2");
  });

  test("text covers training, sharing/selling, no opt-out, alpha status, and links to the legal pages", () => {
    for (const fragment of [
      "used to train models",
      "share or sell",
      "no opt-out",
      "alpha",
      "https://freepi.ai/terms",
      "https://freepi.ai/privacy",
    ]) {
      expect(CONSENT_TEXT).toContain(fragment);
    }
  });
});

describe("parseConsentAnswer — decline is the default (previously untested)", () => {
  test.each([["y"], ["Y"], ["yes"], ["YES"], ["  y  "], ["Yes"]])("%p -> accept", (answer) => {
    expect(parseConsentAnswer(answer)).toBe(true);
  });

  test.each([[""], ["n"], ["no"], ["yep"], ["y u asking"], ["true"], ["1"]])("%p -> decline", (answer) => {
    expect(parseConsentAnswer(answer)).toBe(false);
  });
});
