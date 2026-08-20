import { createInterface } from "node:readline/promises";
import {
  CONSENT_PROMPT,
  CONSENT_TEXT,
  NON_INTERACTIVE_CONSENT_TEXT,
  parseConsentAnswer,
} from "./consent";

export interface ConsentPromptDeps {
  /** process.stdin.isTTY — false/undefined for pipes, CI, cron. */
  stdinIsTTY: boolean;
  log: (message: string) => void;
  /** Shows `prompt` and resolves with one line of user input. */
  askLine: (prompt: string) => Promise<string>;
}

/**
 * Consent gate, deps-injected (test seam like run()'s). On a non-TTY stdin
 * this declines immediately instead of prompting: readline's question
 * promise never settles once piped stdin hits EOF, so the old
 * unconditional prompt hung a CI/piped invocation forever. Declining (never
 * auto-accepting) keeps the direction fail-safe — consent to ads + training
 * must be a deliberate interactive act, and run()'s decline path guarantees
 * zero server calls.
 */
export async function promptConsent(deps: ConsentPromptDeps): Promise<boolean> {
  if (!deps.stdinIsTTY) {
    deps.log(NON_INTERACTIVE_CONSENT_TEXT);
    return false;
  }
  deps.log(CONSENT_TEXT);
  const answer = await deps.askLine(CONSENT_PROMPT);
  return parseConsentAnswer(answer);
}

export async function promptConsentInteractive(): Promise<boolean> {
  return promptConsent({
    stdinIsTTY: process.stdin.isTTY === true,
    log: (message) => console.log(message),
    askLine: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  });
}
