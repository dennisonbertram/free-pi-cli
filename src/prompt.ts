import { createInterface } from "node:readline/promises";
import { CONSENT_PROMPT, CONSENT_TEXT, parseConsentAnswer } from "./consent";

export async function promptConsentInteractive(): Promise<boolean> {
  console.log(CONSENT_TEXT);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(CONSENT_PROMPT);
    return parseConsentAnswer(answer);
  } finally {
    rl.close();
  }
}
