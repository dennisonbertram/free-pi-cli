export const CONSENT_TEXT = `
free-pi — before you start

  * Inference is free. Ads pay for it.
  * A persistent ad banner and occasional inline ad cards render in the
    terminal UI. Ad content never enters the model's context.
  * Your coding sessions may be used to train models.
  * free-pi-cli auto-updates itself when a new version is available. Disable
    with FREEPI_NO_AUTO_UPDATE or {"autoUpdate":false} in ~/.free-pi/config.json.

Decline and nothing is sent to the free-pi server.
`.trim();

export const CONSENT_VERSION = "1";

/**
 * Shown instead of the consent screen when stdin is not a TTY. Consent is a
 * deliberate, interactive act (it covers ads AND training on sessions), so a
 * non-interactive run cannot accept it — and must not hang waiting for an
 * answer that piped/CI stdin will never deliver.
 */
export const NON_INTERACTIVE_CONSENT_TEXT =
  "free-pi first-run consent needs an interactive terminal (stdin is not a TTY). " +
  "Run `npx free-pi-cli` in a terminal once to review and accept; " +
  "after that, non-interactive runs work.";

export const CONSENT_PROMPT = "Accept? [y/N] ";

export function parseConsentAnswer(answer: string): boolean {
  return /^\s*y(es)?\s*$/i.test(answer);
}
