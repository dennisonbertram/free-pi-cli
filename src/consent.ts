export const CONSENT_TEXT = `
free-pi — before you start

  * Inference is free. Ads pay for it, and so does training.
  * Ad cards render in the terminal UI. Ad content never enters the model's
    context.
  * Your coding sessions (prompts, code, files, and model responses) are saved
    as traces and used to train models. We may share or sell that data to
    third parties. Once you accept, there is no opt-out, except where the law
    gives you one.
  * We do our best to remove personal information from traces before we store
    them. We cannot promise it is perfectly clean.
  * free-pi is in alpha and testing. There are no warranties or guarantees,
    expressed or implied, and no guarantee of uptime.
  * If GitHub email capture is enabled, we collect your GitHub email and may
    use it to contact you about the service or product.
  * free-pi-cli auto-updates itself when a new version is available. Disable
    with FREEPI_NO_AUTO_UPDATE or {"autoUpdate":false} in ~/.free-pi/config.json.

By accepting you agree to the Terms of Service (https://freepi.ai/terms)
and the Privacy Policy (https://freepi.ai/privacy).

Decline and nothing is sent to the free-pi server.
`.trim();

export const CONSENT_VERSION = "2";

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
